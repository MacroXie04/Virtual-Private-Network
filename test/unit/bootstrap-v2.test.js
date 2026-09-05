import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrap, readSecretFile } from '../../src/bootstrap.js';
import { GatewayController } from '../../src/controller.js';
import { verifyAdminPassword } from '../../src/credentials.js';
import { renderLegacyV2Config, renderLegacyV2SubscriptionView } from '../../src/legacy-v2.js';
import { RevisionRepository } from '../../src/repository.js';
import { fixtureState } from './core-v2-fixture.js';

async function temporary(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vpn-bootstrap-v3-'));
  try { await run(parent); } finally { await rm(parent, { recursive: true, force: true }); }
}

async function privateFile(filePath, value) {
  await writeFile(filePath, `${value}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function environment(parent) {
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

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function record(bytes) {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

function legacyState() {
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

async function seedLegacyV2(dataDir, {
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

test('fresh bootstrap generates schema-v3 WebSocket state and no REALITY material', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    const repository = new RevisionRepository(env.DATA_DIR);
    let checked;
    let randomByte = 0;
    const result = await bootstrap({
      env,
      repository,
      execFileImpl: async () => { throw new Error('must not generate REALITY keys'); },
      validateConfigImpl: async (candidatePath) => { checked = JSON.parse(await readFile(candidatePath)); },
      randomBytesImpl: (size) => Buffer.alloc(size, ++randomByte),
      now: '2026-09-04T01:00:00.000Z',
    });
    assert.equal(result.status, 'initialized');
    const current = await repository.readCurrent();
    assert.equal(current.state.schemaVersion, 3);
    assert.deepEqual(current.state.gateway, {
      vpnPublicHostname: 'vpn.example.com',
      subscriptionPublicBaseUrl: 'https://sub.example.com',
      adminPublicHostname: 'admin.example.com',
      websocketPath: current.state.gateway.websocketPath,
    });
    assert.equal(/^\/[A-Za-z0-9_-]{43}$/u.test(current.state.gateway.websocketPath), true);
    assert.equal(checked.inbounds[0].listen, '127.0.0.1');
    assert.equal(checked.inbounds[0].listen_port, 8443);
    assert.equal(Object.hasOwn(checked.inbounds[0], 'tls'), false);
    assert.deepEqual(current.state.health.target, { host: 'health.example.net', port: 443 });
    assert.equal(JSON.stringify(current.state).toLowerCase().includes('reality'), false);
    const secret = (await readFile(path.join(env.DATA_DIR, 'admin-secret'), 'utf8')).trim();
    assert.equal(await verifyAdminPassword(secret, current.state.admin.scrypt), true);
  });
});

test('fresh bootstrap rejects public hostname collisions and honors a valid explicit WS_PATH', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    env.ADMIN_PUBLIC_HOSTNAME = env.VPN_PUBLIC_HOSTNAME;
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await assert.rejects(bootstrap({ env, validateConfigImpl: async () => {} }), /must be distinct/u);
  });
  await temporary(async (parent) => {
    const env = environment(parent);
    env.WS_PATH = `/${'Z'.repeat(64)}`;
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    const result = await bootstrap({ env, validateConfigImpl: async () => {}, now: '2026-09-04T01:00:00.000Z' });
    const current = await new RevisionRepository(env.DATA_DIR).readCurrent();
    assert.equal(result.status, 'initialized');
    assert.equal(current.state.gateway.websocketPath, env.WS_PATH);
  });
});

test('schema-v2 migration is explicit, staged in maintenance, and preserves authority', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    const { repo, id, state } = await seedLegacyV2(env.DATA_DIR);
    await assert.rejects(bootstrap({ env, repository: repo }), (error) => error.code === 'REALITY_MIGRATION_REQUIRED');
    assert.equal(await repo.readPointer('current'), id);
    const dryRun = await bootstrap({
      env, repository: repo, realityMigrationMode: 'dry-run', validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, 8), now: '2026-09-04T01:00:00.000Z',
    });
    assert.equal(dryRun.status, 'migration-dry-run');
    assert.equal((await repo.listRevisions()).length, 1);
    const staged = await bootstrap({
      env, repository: repo, realityMigrationMode: 'apply', validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, 9), now: '2026-09-04T01:00:00.000Z',
    });
    assert.equal(staged.status, 'migration-staged');
    assert.equal(await repo.readPointer('current'), id);
    assert.equal(await repo.readPointer('runtime'), staged.id);
    assert.equal((await lstat(path.join(env.DATA_DIR, 'maintenance'))).isFile(), true);
    const candidate = await repo.readRuntime();
    assert.equal(candidate.state.schemaVersion, 3);
    assert.deepEqual(candidate.state.users, state.users);
    assert.deepEqual(candidate.state.tailscale, state.tailscale);
    assert.deepEqual(candidate.state.admin, state.admin);
    assert.equal(JSON.stringify(candidate.state).includes('privateKey'), false);
  });
});

test('explicit WS_PATH resumes the same staged candidate after pointer activation is interrupted', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    env.WS_PATH = `/${'W'.repeat(64)}`;
    const { repo, id } = await seedLegacyV2(env.DATA_DIR);
    const activateRuntime = repo.activateRuntime.bind(repo);
    let interrupted = false;
    repo.activateRuntime = async (candidateId) => {
      if (!interrupted && candidateId !== id) {
        interrupted = true;
        throw new Error('simulated runtime-pointer interruption');
      }
      return activateRuntime(candidateId);
    };

    const options = {
      env,
      repository: repo,
      realityMigrationMode: 'apply',
      validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, 13),
      now: '2026-09-04T01:00:00.000Z',
    };
    await assert.rejects(bootstrap(options), /simulated runtime-pointer interruption/u);
    const revisionsAfterCrash = await repo.listRevisions();
    assert.equal(revisionsAfterCrash.length, 2);
    assert.equal(await repo.readPointer('current'), id);
    assert.equal(await repo.readPointer('runtime'), id);

    const resumed = await bootstrap(options);
    assert.equal(resumed.status, 'migration-staged');
    assert.equal(resumed.id, revisionsAfterCrash.find((revision) => revision.id !== id).id);
    assert.equal((await repo.readRuntime()).state.gateway.websocketPath, env.WS_PATH);
    assert.equal((await repo.listRevisions()).length, 2);
  });
});

test('schema-v2 migration narrowly accepts previously supported authenticated policies', async (t) => {
  const transforms = {
    'pre-routed-DNS': (config) => {
      delete config.dns;
      delete config.route.rules;
      delete config.route.default_domain_resolver;
      delete config.endpoints[0].domain_resolver;
      delete config.inbounds
        .find((inbound) => inbound.tag === 'vless-in').tls.reality.handshake.detour;
    },
    'routed-DNS-before-isolation': (config) => {
      delete config.route.rules;
    },
    'previous-deny-set': (config) => {
      config.route.rules[2].ip_cidr = config.route.rules[2].ip_cidr
        .filter((cidr) => cidr !== '64:ff9b::/96');
    },
  };
  for (const [name, mutateConfig] of Object.entries(transforms)) {
    await t.test(name, async () => temporary(async (parent) => {
      const env = environment(parent);
      const { repo, state } = await seedLegacyV2(env.DATA_DIR, {
        mutateState: (candidate) => {
          candidate.health.target = { host: '192.0.2.10', port: 80 };
        },
        mutateConfig,
      });
      assert.equal((await repo.readCurrent()).requiresIngressMigration, true);
      const staged = await bootstrap({
        env,
        repository: repo,
        realityMigrationMode: 'apply',
        validateConfigImpl: async () => {},
        randomBytesImpl: (size) => Buffer.alloc(size, 12),
        now: '2026-09-04T01:00:00.000Z',
      });
      const candidate = await repo.readRuntime();
      assert.equal(staged.status, 'migration-staged');
      assert.deepEqual(candidate.state.users, state.users);
      assert.deepEqual(candidate.state.tailscale, state.tailscale);
      assert.deepEqual(candidate.state.health.target, { host: 'health.example.net', port: 443 });
    }));
  }
});

test('schema-v2 migration rejects authenticated legacy configuration with extra authority', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    const { repo } = await seedLegacyV2(env.DATA_DIR, {
      mutateConfig: (config) => {
        config.outbounds = [{ type: 'direct', tag: 'direct' }];
      },
    });
    await assert.rejects(repo.readCurrent(), (error) => error.code === 'INVALID_REVISION');
    await assert.rejects(
      bootstrap({ env, repository: repo, realityMigrationMode: 'apply' }),
      (error) => error.code === 'INVALID_REVISION',
    );
  });
});

test('controller commits a staged migration only after restart and composite readiness', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    const { repo, id } = await seedLegacyV2(env.DATA_DIR);
    const staged = await bootstrap({
      env, repository: repo, realityMigrationMode: 'apply', validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, 10), now: '2026-09-04T01:00:00.000Z',
    });
    const events = [];
    const controller = new GatewayController({
      repository: repo,
      dataDir: env.DATA_DIR,
      validateConfig: async () => events.push('check'),
      runtime: {
        restart: async () => events.push('restart'),
        probe: async () => events.push('probe'),
      },
      now: () => new Date('2026-09-04T01:01:00.000Z'),
    });
    const current = await controller.recover();
    assert.equal(current.state.schemaVersion, 3);
    assert.equal(await repo.readPointer('current'), current.id);
    assert.equal(await repo.readPointer('runtime'), current.id);
    assert.deepEqual(events.slice(0, 3), ['check', 'restart', 'probe']);
    assert.equal((await readdir(path.join(env.DATA_DIR, 'revisions'))).includes(id), false);
    assert.notEqual(current.id, staged.id); // enrollment credential scrub creates the final revision
    assert.equal(current.state.tailscale.authKey, null);
  });
});

test('failed migration restores v2 pointers without restarting REALITY and stays in maintenance', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    const { repo, id } = await seedLegacyV2(env.DATA_DIR);
    await bootstrap({
      env, repository: repo, realityMigrationMode: 'apply', validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, 11), now: '2026-09-04T01:00:00.000Z',
    });
    let restarts = 0;
    const controller = new GatewayController({
      repository: repo,
      dataDir: env.DATA_DIR,
      validateConfig: async () => {},
      runtime: {
        restart: async () => { restarts += 1; },
        probe: async () => { throw new Error('routed egress unavailable'); },
      },
    });
    await assert.rejects(controller.recover(), (error) => error.code === 'MIGRATION_FAILED');
    assert.equal(restarts, 1);
    assert.equal(await repo.readPointer('current'), id);
    assert.equal(await repo.readPointer('runtime'), id);
    assert.equal((await lstat(path.join(env.DATA_DIR, 'maintenance'))).isFile(), true);
    assert.equal(controller.ready, false);
  });
});

test('initialized bootstrap is idempotent without rereading settings or rotating secrets', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const secretPath = path.join(env.DATA_DIR, 'admin-secret');
    const before = await readFile(secretPath);

    const result = await bootstrap({
      env: { DATA_DIR: env.DATA_DIR, VPN_PUBLIC_HOSTNAME: 'not a host / and should be ignored' },
      execFileImpl: async () => { throw new Error('must not execute'); },
      validateConfigImpl: async () => { throw new Error('must not validate'); },
      randomBytesImpl: () => { throw new Error('must not rotate credentials'); },
    });
    assert.equal(result.status, 'existing');
    assert.equal(result.revision, 1);
    assert.deepEqual(await readFile(secretPath), before);
  });
});

test('bootstrap refuses to mint a second authority over unpointed committed revisions', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, 7),
      now: '2026-09-04T01:00:00.000Z',
    });
    const revisionsPath = path.join(env.DATA_DIR, 'revisions');
    const before = (await readdir(revisionsPath)).filter((name) => /^\d{16}-[0-9a-f]{16}$/u.test(name));
    await unlink(path.join(env.DATA_DIR, 'current'));
    await unlink(path.join(env.DATA_DIR, 'runtime'));
    await unlink(env.TS_AUTH_KEY_FILE);

    await assert.rejects(bootstrap({
      env: { DATA_DIR: env.DATA_DIR },
      validateConfigImpl: async () => { throw new Error('must not validate'); },
      randomBytesImpl: () => { throw new Error('must not generate credentials'); },
    }), (error) => error.code === 'ORPHANED_REVISION');
    const after = (await readdir(revisionsPath)).filter((name) => /^\d{16}-[0-9a-f]{16}$/u.test(name));
    assert.deepEqual(after, before);
  });
});

test('exclusive startup removes authenticated staging and config-check crash orphans', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const rawOrphan = path.join(
      env.DATA_DIR,
      '.bootstrap-config-11111111-1111-4111-8111-111111111111.json',
    );
    await writeFile(rawOrphan, '{"auth_key":"tskey-auth-orphan"}\n', { mode: 0o600 });
    await chmod(rawOrphan, 0o600);
    const stage = path.join(
      env.DATA_DIR,
      'revisions',
      '.stage-22222222-2222-4222-8222-222222222222',
    );
    await mkdir(stage, { mode: 0o700 });
    await writeFile(path.join(stage, 'sing-box.json'), '{"auth_key":"tskey-auth-stage"}\n', {
      mode: 0o640,
    });

    const result = await bootstrap({ env: { DATA_DIR: env.DATA_DIR } });
    assert.equal(result.status, 'existing');
    await assert.rejects(lstat(rawOrphan), (error) => error.code === 'ENOENT');
    await assert.rejects(lstat(stage), (error) => error.code === 'ENOENT');
  });
});

test('startup refuses an unsafe config-check orphan without following it', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const target = path.join(parent, 'must-remain');
    const orphan = path.join(
      env.DATA_DIR,
      '.bootstrap-config-33333333-3333-4333-8333-333333333333.json',
    );
    await privateFile(target, 'do-not-delete');
    await symlink(target, orphan);

    await assert.rejects(
      bootstrap({ env: { DATA_DIR: env.DATA_DIR } }),
      (error) => error.code === 'UNSAFE_FILE',
    );
    assert.equal((await lstat(orphan)).isSymbolicLink(), true);
    assert.equal((await readFile(target, 'utf8')).trim(), 'do-not-delete');
  });
});

test('bootstrap recovers a missing current pointer without rereading secrets', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    await unlink(path.join(env.DATA_DIR, 'current'));
    const recovered = await bootstrap({ env: { DATA_DIR: env.DATA_DIR } });
    const repository = new RevisionRepository(env.DATA_DIR);
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.revision, 1);
    assert.equal(await repository.readPointer('current'), await repository.readPointer('runtime'));
  });
});

test('bootstrap restores current authority after an interrupted runtime-pointer transaction', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const repository = new RevisionRepository(env.DATA_DIR);
    const authoritative = await repository.readCurrent();
    const candidate = await repository.createRevision({
      ...authoritative.state,
      revision: authoritative.state.revision + 1,
      updatedAt: '2026-09-04T01:01:00.000Z',
      gateway: {
        ...authoritative.state.gateway,
        subscriptionPublicBaseUrl: 'https://uncommitted.example',
      },
    }, { operation: 'test.interrupted' });
    await repository.activateRuntime(candidate.id);

    const recovered = await bootstrap({ env: { DATA_DIR: env.DATA_DIR } });
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.id, authoritative.id);
    assert.equal(await repository.readPointer('current'), authoritative.id);
    assert.equal(await repository.readPointer('runtime'), authoritative.id);
  });
});

test('bootstrap reads Tailscale credentials only from bounded private regular files', async () => {
  await temporary(async (parent) => {
    const target = path.join(parent, 'target-secret');
    const linked = path.join(parent, 'linked-secret');
    await privateFile(target, 'tskey-auth-private');
    await symlink(target, linked);
    await assert.rejects(readSecretFile(linked), (error) => error.code === 'UNSAFE_FILE');

    const broad = path.join(parent, 'broad-secret');
    await writeFile(broad, 'tskey-auth-broad\n', { mode: 0o644 });
    await chmod(broad, 0o644);
    await assert.rejects(readSecretFile(broad), (error) => error.code === 'UNSAFE_PERMISSIONS');

    const oversized = path.join(parent, 'oversized-secret');
    await privateFile(oversized, 'x'.repeat(1100));
    await assert.rejects(readSecretFile(oversized), (error) => error.code === 'UNSAFE_FILE');
  });
});

test('a rejected sing-box candidate leaves no secret, pointer, or temporary config', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await assert.rejects(bootstrap({
      env,
      validateConfigImpl: async () => { throw new Error('candidate rejected'); },
      now: '2026-09-04T01:00:00.000Z',
    }), (error) => error.code === 'CONFIG_REJECTED');
    const entries = await readdir(env.DATA_DIR);
    assert.equal(entries.includes('admin-secret'), false);
    assert.equal(entries.includes('current'), false);
    assert.equal(entries.some((name) => name.startsWith('.bootstrap-config-')), false);
  });
});

test('direct secret environment variables cannot replace required secret files', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    delete env.TS_AUTH_KEY_FILE;
    delete env.TS_API_KEY_FILE;
    env.TS_AUTH_KEY = 'tskey-auth-must-be-ignored';
    await assert.rejects(bootstrap({ env }), (error) => (
      error.code === 'MISSING_CONFIGURATION' && /TS_AUTH_KEY_FILE/u.test(error.message)
    ));
  });
});
