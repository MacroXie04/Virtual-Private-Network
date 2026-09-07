import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { bootstrap } from '../../src/state/bootstrap-service.js';
import {
  renderLegacyV2Config,
  renderLegacyV2SubscriptionView,
} from '../../src/migrations/legacy-v2-policy.js';
import { RevisionRepository } from '../../src/state/repository.js';
import { fixtureState } from '../fixtures/state.js';

export async function temporary(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vpn-bootstrap-v3-'));
  try { await run(parent); } finally { await rm(parent, { recursive: true, force: true }); }
}

export async function privateFile(filePath, value) {
  await writeFile(filePath, `${value}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

export function environment(parent) {
  const dataDir = path.join(parent, 'data');
  return {
    DATA_DIR: dataDir,
    SINGBOX_CONFIG: path.join(dataDir, 'runtime', 'sing-box.json'),
    SINGBOX_BIN: '/usr/bin/sing-box',
    SINGBOX_STATE_DIR: path.join(dataDir, 'tailscale'),
    HEALTH_PORT: '19080',
    EXIT_NODE: '100.64.0.10',
    TS_HOSTNAME: 'vpn-gateway',
    VPN_PUBLIC_HOSTNAME: 'vpn.example.com',
    SUBSCRIPTION_PUBLIC_BASE_URL: 'https://sub.example.com',
    ADMIN_PUBLIC_HOSTNAME: 'admin.example.com',
    EGRESS_HEALTH_HOST: 'health.example.net',
    TS_AUTH_KEY_FILE: path.join(parent, 'tailscale-auth'),
    TS_API_KEY_FILE: path.join(parent, 'tailscale-api'),
  };
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function record(bytes) {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

export function legacyState() {
  const active = fixtureState();
  return {
    schemaVersion: 2,
    revision: 7,
    createdAt: active.createdAt,
    updatedAt: active.updatedAt,
    gateway: {
      host: { kind: 'dns', value: 'legacy.example.com' },
      advertisedPort: 443,
      listenPort: 443,
      publicBaseUrl: 'https://legacy-sub.example.com',
    },
    reality: {
      privateKey: 'UuMBgl7MXTPx9inmQp2UC7Jcnwc6XYbwDNebonM-FCc', // gitleaks:allow
      publicKey: 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0',
      serverName: 'www.example.com',
      shortId: 'a1b2c3d4',
    },
    tailscale: active.tailscale,
    health: { ...active.health, target: { host: 'www.example.com', port: 443 } },
    admin: active.admin,
    users: active.users,
  };
}

export async function seedLegacyV2(dataDir, {
  mutateState = () => {},
  mutateConfig = () => {},
} = {}) {
  const repo = new RevisionRepository(dataDir, { allowLegacyMigration: true });
  await repo.ensure();
  const state = legacyState();
  mutateState(state);
  const config = renderLegacyV2Config(state);
  mutateConfig(config);
  const values = {
    'state.json': jsonBytes(state),
    'sing-box.json': jsonBytes(config),
    'subscription-view.json': jsonBytes(renderLegacyV2SubscriptionView(state)),
  };
  const manifest = {
    schemaVersion: 1,
    revision: state.revision,
    operation: 'bootstrap',
    createdAt: state.updatedAt,
    files: Object.fromEntries(Object.entries(values).map(([name, bytes]) => [name, record(bytes)])),
  };
  const id = `${String(state.revision).padStart(16, '0')}-${record(values['state.json']).sha256.slice(0, 16)}`;
  const revisionPath = path.join(dataDir, 'revisions', id);
  await mkdir(revisionPath, { mode: 0o751 });
  await writeFile(path.join(revisionPath, 'state.json'), values['state.json'], { mode: 0o600 });
  await writeFile(path.join(revisionPath, 'sing-box.json'), values['sing-box.json'], { mode: 0o640 });
  await writeFile(path.join(revisionPath, 'subscription-view.json'), values['subscription-view.json'], { mode: 0o640 });
  await writeFile(path.join(revisionPath, 'manifest.json'), jsonBytes(manifest), { mode: 0o600 });
  await chmod(revisionPath, 0o751);
  await symlink(`revisions/${id}`, path.join(dataDir, 'current'));
  await symlink(`revisions/${id}`, path.join(dataDir, 'runtime'));
  return { repo, id, state };
}
