import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { lstat, readdir } from 'node:fs/promises';
import { bootstrap } from '../../src/state/bootstrap-service.js';
import { GatewayController } from '../../src/control/controller.js';
import { temporary, environment, seedLegacyV2 } from '../fixtures/bootstrap.js';

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
