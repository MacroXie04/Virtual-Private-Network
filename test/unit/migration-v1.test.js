import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { lstat, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { bootstrap } from '../../src/state/bootstrap-service.js';
import { verifySubscriptionToken } from '../../src/core/credentials.js';
import { migrateLegacyV1 } from '../../src/migrations/migrate-v1.js';
import { parseLegacyEnvironment } from '../../src/migrations/legacy-v1-parse.js';
import { RevisionRepository } from '../../src/state/repository.js';
import {
  LEGACY_UUID,
  LEGACY_TOKEN,
  temporary,
  targetEnvironment,
  writeLegacy,
} from '../fixtures/legacy-migration.js';

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
