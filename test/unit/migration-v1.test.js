import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrap } from '../../src/state/bootstrap.js';
import { GatewayController } from '../../src/control/controller.js';
import { verifySubscriptionToken } from '../../src/core/credentials.js';
import {
  assertLegacyV1MigrationLineage,
  migrateLegacyV1,
  parseLegacyEnvironment,
} from '../../src/migrations/migrate-v1.js';
import { RevisionRepository } from '../../src/state/repository.js';

const LEGACY_UUID = '11111111-1111-4111-8111-111111111111';
// Generate the deterministic legacy token fixture rather than embedding a credential-shaped literal.
const LEGACY_TOKEN = Array.from({ length: 32 }, (_, index) => (index % 16).toString(16)).join('');
const PRIVATE_KEY = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM';
const PUBLIC_KEY = 'Xf7dO2vUf2-ijuFdlp1bsOpTd01Ii9r53xxuASSz7yI';

async function temporary(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vpn-migration-v2-'));
  try {
    await run(parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function legacyEnvironment(overrides = {}) {
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

function targetEnvironment(overrides = {}) {
  return {
    VPN_PUBLIC_HOSTNAME: 'vpn.example.com',
    SUBSCRIPTION_PUBLIC_BASE_URL: 'https://sub.example.com',
    ADMIN_PUBLIC_HOSTNAME: 'admin.example.com',
    EGRESS_HEALTH_HOST: 'health.example.net',
    ...overrides,
  };
}

function serializeEnvironment(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function legacyConfig(stateDirectory, overrides = {}) {
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

async function writeLegacy(parent, environmentOverrides = {}, configOverrides = {}) {
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

async function writeMigrationMarker(dataDir, { envPath, configPath, stateDirectory }) {
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

async function orphanedMigrationFixture(parent, { apiFromFile = false } = {}) {
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

test('legacy KEY=value parsing is allowlisted and never evaluates shell syntax', () => {
  const parsed = parseLegacyEnvironment([
    'SUB_TOKEN=$(touch /tmp/this-is-data-not-code)',
    'VPS_HOST="vpn.example.com"',
    "NODE_NAME='Legacy phone'",
    '',
  ].join('\n'));
  assert.equal(parsed.SUB_TOKEN, '$(touch /tmp/this-is-data-not-code)');
  assert.equal(parsed.VPS_HOST, 'vpn.example.com');
  assert.equal(parsed.NODE_NAME, 'Legacy phone');
  assert.throws(
    () => parseLegacyEnvironment('LD_PRELOAD=/tmp/evil.so\n'),
    /not allowlisted/,
  );
  assert.throws(
    () => parseLegacyEnvironment('UUID=one\nUUID=two\n'),
    /duplicated/,
  );
});

test('migration defaults to a sanitized dry run with no filesystem writes', async () => {
  await temporary(async (parent) => {
    const { envPath, configPath, stateDirectory } = await writeLegacy(parent);
    const dataDir = path.join(parent, 'new-data');
    await mkdir(dataDir);
    const before = await readdir(dataDir);
    const result = await migrateLegacyV1({
      dataDir,
      envPath,
      configPath,
      env: targetEnvironment(),
    });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.summary.vpnPublicHostname, 'vpn.example.com');
    assert.equal(result.summary.subscriptionPublicBaseUrl, 'https://sub.example.com');
    assert.equal(result.summary.egressHealthHost, 'health.example.net');
    assert.equal(result.summary.tailscaleStateDirectory, stateDirectory);
    assert.equal(JSON.stringify(result).includes(LEGACY_TOKEN), false);
    assert.deepEqual(await readdir(dataDir), before);
  });
});

test('migration can relocate legacy tsnet state into the hardened runtime directory', async () => {
  await temporary(async (parent) => {
    const { envPath, configPath, stateDirectory } = await writeLegacy(parent);
    const dataDir = path.join(parent, 'new-data');
    const relocated = path.join(dataDir, 'tailscale');
    await mkdir(dataDir);
    const result = await migrateLegacyV1({
      dataDir,
      envPath,
      configPath,
      env: targetEnvironment({ MIGRATION_STATE_DIR: relocated }),
    });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.summary.tailscaleStateDirectory, relocated);
    assert.notEqual(result.summary.tailscaleStateDirectory, stateDirectory);
  });
});

test('applied migration preserves client identity and tsnet state but renders a new fail-closed config', async () => {
  await temporary(async (parent) => {
    const { envPath, configPath, stateDirectory } = await writeLegacy(parent);
    const dataDir = path.join(parent, 'new-data');
    await mkdir(dataDir);
    const events = [];
    class RecordingRepository extends RevisionRepository {
      async initialize(...args) {
        events.push('initialize');
        return super.initialize(...args);
      }
    }
    const repository = new RecordingRepository(dataDir);
    let randomByte = 0;
    const result = await migrateLegacyV1({
      apply: true,
      dataDir,
      envPath,
      configPath,
      env: targetEnvironment(),
      repository,
      singBoxPath: '/usr/bin/sing-box',
      validateConfigImpl: async (candidatePath) => {
        const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
        assert.equal(candidate.route.final, 'ts-out');
        assert.equal(Object.hasOwn(candidate, 'outbounds'), false);
        assert.equal(candidate.inbounds[0].listen_port, 8443);
        assert.equal(candidate.inbounds[0].listen, '127.0.0.1');
        assert.equal(Object.hasOwn(candidate.inbounds[0], 'tls'), false);
        const healthInbound = candidate.inbounds.find((inbound) => inbound.tag === 'health-in');
        assert.equal(healthInbound.users[0].username, 'vpn-health');
        assert.equal(Buffer.from(healthInbound.users[0].password, 'base64url').length, 32);
        assert.equal(await lstat(path.join(dataDir, 'legacy-backups')).then(() => true, () => false), false);
        events.push('check');
      },
      randomBytesImpl: (size) => Buffer.alloc(size, ++randomByte),
      now: '2026-09-04T02:00:00.000Z',
    });

    assert.deepEqual(events, ['check', 'initialize']);
    assert.equal(result.status, 'migrated');
    const current = await repository.readCurrent();
    assert.equal(current.state.users.length, 1);
    assert.equal(current.state.schemaVersion, 3);
    assert.equal(current.state.users[0].uuid, LEGACY_UUID);
    assert.equal(verifySubscriptionToken(LEGACY_TOKEN, current.state.users[0].tokenHash), true);
    assert.equal(JSON.stringify(current.state).includes(LEGACY_TOKEN), false);
    assert.equal(current.state.tailscale.stateDirectory, stateDirectory);
    assert.equal(current.state.tailscale.authKey, 'tskey-auth-legacy-test');
    assert.equal(current.state.tailscale.apiKey, 'tskey-api-legacy-test');
    assert.equal(Buffer.from(current.state.health.password, 'base64url').length, 32);
    assert.equal(
      current.state.health.password,
      current.config.inbounds.find((inbound) => inbound.tag === 'health-in').users[0].password,
    );
    assert.equal(current.config.inbounds[0].users[0].uuid, LEGACY_UUID);
    assert.equal(current.config.inbounds[0].transport.path, current.state.gateway.websocketPath);
    assert.equal(JSON.stringify(current.state).includes('REALITY_PRIVATE_KEY'), false);
    assert.equal(Object.hasOwn(current.config, 'outbounds'), false);

    assert.equal((await lstat(result.backupPath)).mode & 0o777, 0o700);
    for (const name of ['environment.env', 'sing-box.json', 'manifest.json']) {
      assert.equal((await lstat(path.join(result.backupPath, name))).mode & 0o777, 0o600);
    }
    assert.deepEqual(await readFile(path.join(result.backupPath, 'environment.env')), await readFile(envPath));
    assert.equal((await lstat(path.join(dataDir, 'admin-secret'))).mode & 0o777, 0o600);
  });
});

test('bootstrap recovers one exact marker-bound migrate-v1 orphan before either pointer', async () => {
  await temporary(async (parent) => {
    const fixture = await orphanedMigrationFixture(parent, { apiFromFile: true });
    const result = await bootstrap({
      env: fixture.env,
      migrationMode: 'apply',
      validateConfigImpl: async () => {},
      randomBytesImpl: () => { throw new Error('orphan recovery must not mint new state'); },
    });
    assert.equal(result.status, 'recovered');
    assert.equal(result.revision, 1);
    const current = await fixture.repository.readCurrent();
    const runtime = await fixture.repository.readRuntime();
    assert.equal(current.id, result.id);
    assert.equal(runtime.id, result.id);
    assert.equal(current.manifest.operation, 'migrate-v1');
    assert.equal(current.state.tailscale.apiKey, 'tskey-api-protected-file-only');
    assert.equal((await fixture.repository.listRevisions()).length, 1);
    assert.equal((await readdir(path.join(fixture.dataDir, 'legacy-backups'))).length, 1);
  });
});

test('marker-bound orphan recovery rejects multiple, unrelated, and tampered revisions', async (t) => {
  await t.test('multiple and unrelated revisions', async () => {
    await temporary(async (parent) => {
      const fixture = await orphanedMigrationFixture(parent);
      const [approved] = await fixture.repository.listRevisions();
      const approvedRevision = await fixture.repository.readRevision(approved.id);
      const unboundEnvironment = { ...fixture.env };
      delete unboundEnvironment.MIGRATION_MARKER_DIR;
      await assert.rejects(bootstrap({
        env: unboundEnvironment,
        migrationMode: 'apply',
        validateConfigImpl: async () => {},
      }), (error) => error.code === 'ORPHANED_REVISION');

      const unrelatedState = structuredClone(approvedRevision.state);
      unrelatedState.revision = 2;
      unrelatedState.updatedAt = '2026-09-04T03:00:01.000Z';
      const unrelated = await fixture.repository.createRevision(unrelatedState, { operation: 'user.update' });

      await assert.rejects(bootstrap({
        env: fixture.env,
        migrationMode: 'apply',
        validateConfigImpl: async () => {},
      }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');

      assert.equal(await fixture.repository.removeRevision(approved.id), true);
      assert.deepEqual((await fixture.repository.listRevisions()).map(({ id }) => id), [unrelated.id]);
      await assert.rejects(bootstrap({
        env: fixture.env,
        migrationMode: 'apply',
        validateConfigImpl: async () => {},
      }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');
    });
  });

  await t.test('tampered revision', async () => {
    await temporary(async (parent) => {
      const fixture = await orphanedMigrationFixture(parent);
      const [approved] = await fixture.repository.listRevisions();
      const statePath = path.join(approved.path, 'state.json');
      const stateBytes = await readFile(statePath);
      await writeFile(statePath, Buffer.concat([stateBytes, Buffer.from(' ')]));
      await assert.rejects(bootstrap({
        env: fixture.env,
        migrationMode: 'apply',
        validateConfigImpl: async () => {},
      }), (error) => error.code === 'REVISION_TAMPERED');
    });
  });
});

test('bare migration resume accepts only the initial v1 lineage or its controller credential scrub', async () => {
  await temporary(async (parent) => {
    const { envPath, configPath } = await writeLegacy(parent, { TS_API_KEY: undefined });
    const dataDir = path.join(parent, 'new-data');
    const stateDirectory = path.join(dataDir, 'tailscale');
    const lineagePath = path.join(parent, 'lineage.json');
    const websocketPath = `/${'A'.repeat(43)}`;
    const apiKeyPath = path.join(parent, 'tailscale-api-key');
    await mkdir(dataDir);
    await writeFile(apiKeyPath, 'tskey-api-lineage-file-only\n', { mode: 0o600 });
    await chmod(apiKeyPath, 0o600);
    const migrationEnvironment = targetEnvironment({
      MIGRATION_STATE_DIR: stateDirectory,
      TS_API_KEY_FILE: apiKeyPath,
      WS_PATH: websocketPath,
    });
    const lineageEnvironment = targetEnvironment({
      TS_API_KEY_FILE: apiKeyPath,
      WS_PATH: websocketPath,
    });
    const repository = new RevisionRepository(dataDir);
    let randomByte = 0;
    await migrateLegacyV1({
      apply: true,
      dataDir,
      envPath,
      configPath,
      env: migrationEnvironment,
      repository,
      validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, ++randomByte),
      now: '2026-09-04T02:00:00.000Z',
    });

    const initial = await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      repository,
    });
    assert.equal(initial.status, 'migrate-v1');
    assert.equal(initial.revision, 1);

    const initialRevision = await repository.readCurrent();
    const scrubState = (updatedAt) => ({
      ...structuredClone(initialRevision.state),
      revision: 2,
      updatedAt,
      tailscale: {
        ...initialRevision.state.tailscale,
        authKey: null,
        apiKey: null,
      },
    });

    // Hard crash after candidate creation, before the runtime pointer switch.
    const createdOnly = await repository.createRevision(
      scrubState('2026-09-04T02:00:01.000Z'),
      { operation: 'credentials.scrub' },
    );
    await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    });
    assert.equal(await repository.readRevision(createdOnly.id).then(() => true, () => false), false);

    // Hard crash after runtime activation, before current activation. Bootstrap
    // restores runtime to current; lineage recovery then retires the unproven
    // scrub candidate so the controller can rerun its routed transaction.
    const runtimeOnly = await repository.createRevision(
      scrubState('2026-09-04T02:00:02.000Z'),
      { operation: 'credentials.scrub' },
    );
    await repository.activateRuntime(runtimeOnly.id);
    const pointerRecovery = await bootstrap({ env: { DATA_DIR: dataDir }, repository });
    assert.equal(pointerRecovery.status, 'recovered');
    assert.equal((await repository.readRuntime()).id, initial.id);
    await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    });
    assert.equal(await repository.readRevision(runtimeOnly.id).then(() => true, () => false), false);

    // Hard crash after current activation, before credential-history cleanup.
    const currentScrub = await repository.createRevision(
      scrubState('2026-09-04T02:00:03.000Z'),
      { operation: 'credentials.scrub' },
    );
    await repository.activateRuntime(currentScrub.id);
    await repository.activateCurrent(currentScrub.id);
    const currentBoundary = await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    });
    assert.equal(currentBoundary.status, 'credentials.scrub');
    assert.equal((await repository.listRevisions()).length, 2);

    const runtime = {
      async restart() {},
      async probe() { return true; },
    };
    const controller = new GatewayController({
      repository,
      runtime,
      validateConfig: async () => {},
      dataDir,
      now: () => new Date('2026-09-04T02:00:04.000Z'),
    });
    const ready = await controller.recover();
    assert.equal(controller.ready, true);
    assert.equal(ready.manifest.operation, 'credentials.scrub');
    assert.equal((await repository.listRevisions()).length, 1);

    await assert.rejects(assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      repository,
    }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');

    // This is the installer resume point after service readiness but before
    // the outer migration marker was durably committed.
    const resumed = await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    });
    assert.equal(resumed.status, 'credentials.scrub');
    assert.equal(resumed.revision, 2);
    assert.equal(resumed.initialRevisionId, initial.id);

    const scrubbed = await repository.readCurrent();
    const forgedState = structuredClone(scrubbed.state);
    forgedState.gateway.vpnPublicHostname = 'unrelated.example.com';
    const forged = await repository.createRevision(forgedState, { operation: 'credentials.scrub' });
    await repository.activateRuntime(forged.id);
    await repository.activateCurrent(forged.id);
    await assert.rejects(assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');

    const unrelatedState = structuredClone(scrubbed.state);
    unrelatedState.revision = 3;
    unrelatedState.updatedAt = '2026-09-04T02:00:02.000Z';
    const unrelated = await repository.createRevision(unrelatedState, { operation: 'user.update' });
    await repository.activateRuntime(unrelated.id);
    await repository.activateCurrent(unrelated.id);
    await assert.rejects(assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');

    await repository.activateRuntime(scrubbed.id);
    await repository.activateCurrent(scrubbed.id);
    await writeFile(path.join(scrubbed.path, 'state.json'), `${JSON.stringify(scrubbed.state)}\n `);
    await assert.rejects(assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    }), (error) => error.code === 'REVISION_TAMPERED');
  });
});

test('migration fails closed on conflicting sources and symlink inputs', async () => {
  await temporary(async (parent) => {
    const { envPath, configPath } = await writeLegacy(parent, {
      UUID: '22222222-2222-4222-8222-222222222222',
    });
    await assert.rejects(migrateLegacyV1({
      dataDir: path.join(parent, 'data'),
      envPath,
      configPath,
      env: targetEnvironment(),
    }), (error) => error.code === 'CONFLICTING_LEGACY_STATE');
  });

  await temporary(async (parent) => {
    const { envPath, configPath } = await writeLegacy(parent);
    const linked = path.join(parent, 'linked.env');
    await symlink(envPath, linked);
    await assert.rejects(migrateLegacyV1({
      dataDir: path.join(parent, 'data'),
      envPath: linked,
      configPath,
      env: targetEnvironment(),
    }), (error) => error.code === 'UNSAFE_FILE');
  });

  await temporary(async (parent) => {
    const { envPath, configPath } = await writeLegacy(parent, {
      SUB_TOKEN: `${'a'.repeat(31)}/`,
    });
    await assert.rejects(migrateLegacyV1({
      dataDir: path.join(parent, 'data'),
      envPath,
      configPath,
      env: targetEnvironment(),
    }), /URL-safe token/u);
  });
});

test('bootstrap requires explicit legacy migration approval and supports a review-only mode', async () => {
  await temporary(async (parent) => {
    const dataDir = path.join(parent, 'data');
    await mkdir(dataDir);
    const source = await writeLegacy(parent);
    const env = {
      DATA_DIR: dataDir,
      SINGBOX_CONFIG: path.join(dataDir, 'runtime', 'sing-box.json'),
      SINGBOX_BIN: '/usr/bin/sing-box',
      LEGACY_ENV_FILE: source.envPath,
      LEGACY_CONFIG_FILE: source.configPath,
      ...targetEnvironment(),
    };
    await assert.rejects(bootstrap({ env }), (error) => error.code === 'LEGACY_MIGRATION_REQUIRED');
    const reviewed = await bootstrap({ env, migrationMode: 'dry-run' });
    assert.equal(reviewed.status, 'dry-run');
    assert.equal(await lstat(path.join(dataDir, 'current')).then(() => true, () => false), false);
    assert.equal(await lstat(path.join(dataDir, 'revisions')).then(() => true, () => false), false);
  });
});
