import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { bootstrap } from '../../src/state/bootstrap-service.js';
import { RevisionRepository } from '../../src/state/repository.js';

export const LEGACY_UUID = '11111111-1111-4111-8111-111111111111';
// Generate the deterministic legacy token fixture rather than embedding a credential-shaped literal.
export const LEGACY_TOKEN = Array.from({ length: 32 }, (_, index) => (index % 16).toString(16)).join('');
export const PRIVATE_KEY = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM';
export const PUBLIC_KEY = 'Xf7dO2vUf2-ijuFdlp1bsOpTd01Ii9r53xxuASSz7yI';

export async function temporary(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vpn-migration-v2-'));
  try {
    await run(parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

export function legacyEnvironment(overrides = {}) {
  const environment = {
    UUID: LEGACY_UUID,
    SHORT_ID: '0123456789abcdef',
    SUB_TOKEN: LEGACY_TOKEN,
    REALITY_PRIVATE_KEY: PRIVATE_KEY,
    REALITY_PUBLIC_KEY: PUBLIC_KEY,
    VPS_HOST: 'legacy-vpn.example.com',
    SERVER_NAME: 'www.example.com',
    NODE_NAME: 'Legacy Phone',
    NODE_PORT: '443',
    TS_API_KEY: 'tskey-api-legacy-test',
    ...overrides,
  };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[key];
  }
  return environment;
}

export function targetEnvironment(overrides = {}) {
  return {
    VPN_PUBLIC_HOSTNAME: 'vpn.example.com',
    SUBSCRIPTION_PUBLIC_BASE_URL: 'https://sub.example.com',
    ADMIN_PUBLIC_HOSTNAME: 'admin.example.com',
    EGRESS_HEALTH_HOST: 'health.example.net',
    ...overrides,
  };
}

export function serializeEnvironment(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

export function legacyConfig(stateDirectory, overrides = {}) {
  return {
    log: { level: 'info' },
    inbounds: [{
      type: 'vless',
      tag: 'vless-in',
      listen: '::',
      listen_port: 443,
      users: [{ name: 'main', uuid: LEGACY_UUID, flow: 'xtls-rprx-vision' }],
      tls: {
        enabled: true,
        server_name: 'www.example.com',
        reality: {
          enabled: true,
          handshake: { server: 'www.example.com', server_port: 443 },
          private_key: PRIVATE_KEY,
          short_id: ['0123456789abcdef'],
        },
      },
    }],
    endpoints: [{
      type: 'tailscale',
      tag: 'ts-out',
      state_directory: stateDirectory,
      auth_key: 'tskey-auth-legacy-test',
      hostname: 'legacy-tsnet-node',
      exit_node: '100.64.0.20',
      ephemeral: false,
    }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'ts-out' },
    ...overrides,
  };
}

export async function writeLegacy(parent, environmentOverrides = {}, configOverrides = {}) {
  const envPath = path.join(parent, 'legacy.env');
  const configPath = path.join(parent, 'legacy.json');
  const stateDirectory = path.join(parent, 'old-tsnet-state');
  await mkdir(stateDirectory);
  await writeFile(envPath, serializeEnvironment(legacyEnvironment(environmentOverrides)), { mode: 0o600 });
  await writeFile(configPath, `${JSON.stringify(legacyConfig(stateDirectory, configOverrides), null, 2)}\n`, {
    mode: 0o640,
  });
  await chmod(envPath, 0o600);
  await chmod(configPath, 0o640);
  return { envPath, configPath, stateDirectory };
}

export async function writeMigrationMarker(dataDir, { envPath, configPath, stateDirectory }) {
  const markerDir = path.join(dataDir, '.legacy-migration-in-progress');
  await mkdir(markerDir, { mode: 0o700 });
  await chmod(markerDir, 0o700);
  const records = {
    'env.sha256': createHash('sha256').update(await readFile(envPath)).digest('hex'),
    'config.sha256': createHash('sha256').update(await readFile(configPath)).digest('hex'),
    'source-state': stateDirectory,
  };
  for (const [name, value] of Object.entries(records)) {
    const markerPath = path.join(markerDir, name);
    await writeFile(markerPath, `${value}\n`, { mode: 0o600 });
    await chmod(markerPath, 0o600);
  }
  const stateCopied = path.join(markerDir, 'state-copied');
  await writeFile(stateCopied, '', { mode: 0o600 });
  await chmod(stateCopied, 0o600);
  return markerDir;
}

export async function orphanedMigrationFixture(parent, { apiFromFile = false } = {}) {
  const source = await writeLegacy(parent, apiFromFile ? { TS_API_KEY: undefined } : {});
  const dataDir = path.join(parent, 'new-data');
  const migratedStateDirectory = path.join(dataDir, 'tailscale');
  const websocketPath = `/${'C'.repeat(43)}`;
  await mkdir(dataDir);
  const markerDir = await writeMigrationMarker(dataDir, source);
  const env = {
    DATA_DIR: dataDir,
    SINGBOX_CONFIG: path.join(dataDir, 'runtime', 'sing-box.json'),
    SINGBOX_BIN: '/usr/bin/sing-box',
    LEGACY_ENV_FILE: source.envPath,
    LEGACY_CONFIG_FILE: source.configPath,
    MIGRATION_STATE_DIR: migratedStateDirectory,
    MIGRATION_MARKER_DIR: markerDir,
    WS_PATH: websocketPath,
    ...targetEnvironment(),
  };
  if (apiFromFile) {
    env.TS_API_KEY_FILE = path.join(parent, 'tailscale-api-key');
    await writeFile(env.TS_API_KEY_FILE, 'tskey-api-protected-file-only\n', { mode: 0o600 });
    await chmod(env.TS_API_KEY_FILE, 0o600);
  }
  class CrashBeforeRuntimePointerRepository extends RevisionRepository {
    async activateRuntime() {
      throw new Error('simulated hard crash before runtime pointer publication');
    }
  }
  await assert.rejects(bootstrap({
    env,
    repository: new CrashBeforeRuntimePointerRepository(dataDir),
    migrationMode: 'apply',
    validateConfigImpl: async () => {},
    randomBytesImpl: (size) => Buffer.alloc(size, 9),
    now: '2026-09-04T03:00:00.000Z',
  }), /simulated hard crash/u);
  const repository = new RevisionRepository(dataDir);
  assert.equal(await lstat(path.join(dataDir, 'current')).then(() => true, () => false), false);
  assert.equal(await lstat(path.join(dataDir, 'runtime')).then(() => true, () => false), false);
  assert.equal((await repository.listRevisions()).length, 1);
  assert.equal(await lstat(path.join(markerDir, 'lineage.json')).then(() => true, () => false), true);
  return {
    ...source,
    dataDir,
    migratedStateDirectory,
    markerDir,
    websocketPath,
    env,
    repository,
  };
}
