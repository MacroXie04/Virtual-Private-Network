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
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bootstrap,
  readSecretFile,
} from '../../src/bootstrap.js';
import { GatewayController } from '../../src/controller.js';
import { verifyAdminPassword } from '../../src/credentials.js';
import { assertLegacyV2Config } from '../../src/render.js';
import { RevisionRepository } from '../../src/repository.js';
import { fixtureState } from './core-v2-fixture.js';

async function temporary(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vpn-bootstrap-v2-'));
  try {
    await run(parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
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
    VPS_HOST: 'vpn.example.com',
    ADVERTISED_PORT: '443',
    LISTEN_PORT: '8443',
    HEALTH_PORT: '19080',
    SERVER_NAME: 'www.example.com',
    EXIT_NODE: '100.64.0.10',
    TS_HOSTNAME: 'vpn-gateway',
    PUBLIC_BASE_URL: 'https://subscriptions.example.com',
    TS_AUTH_KEY_FILE: path.join(parent, 'tailscale-auth'),
    TS_API_KEY_FILE: path.join(parent, 'tailscale-api'),
  };
}

function keyGenerator(calls) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: 'PrivateKey: UuMBgl7MXTPx9inmQp2UC7Jcnwc6XYbwDNebonM-FCc\nPublicKey: jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0\n',
      stderr: '',
    };
  };
}

function serialized(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function manifestRecord(bytes) {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

async function rewriteAsPreviousV2(repository, mutateConfig = () => {}) {
  const current = await repository.readCurrent();
  const state = structuredClone(current.state);
  const config = structuredClone(current.config);
  const view = structuredClone(current.subscriptionView);
  const manifest = structuredClone(current.manifest);
  state.health.target = { host: '1.1.1.1', port: 443 };
  delete config.dns;
  delete config.route.rules;
  delete config.route.default_domain_resolver;
  delete config.endpoints[0].domain_resolver;
  delete config.inbounds
    .find((inbound) => inbound.tag === 'vless-in').tls.reality.handshake.detour;
  mutateConfig(config);
  const values = {
    'state.json': state,
    'sing-box.json': config,
    'subscription-view.json': view,
  };
  for (const [name, value] of Object.entries(values)) {
    const bytes = serialized(value);
    manifest.files[name] = manifestRecord(bytes);
    await writeFile(path.join(current.path, name), bytes);
  }
  await writeFile(path.join(current.path, 'manifest.json'), serialized(manifest));
  return current.id;
}

async function removePreviousV2IsolationRules(repository) {
  const current = await repository.readCurrent();
  const config = structuredClone(current.config);
  const manifest = structuredClone(current.manifest);
  delete config.route.rules;
  const configBytes = serialized(config);
  manifest.files['sing-box.json'] = manifestRecord(configBytes);
  await writeFile(path.join(current.path, 'sing-box.json'), configBytes);
  await writeFile(path.join(current.path, 'manifest.json'), serialized(manifest));
  return current.id;
}

async function restorePreviousSpecialUseDenySet(repository) {
  const current = await repository.readCurrent();
  const config = structuredClone(current.config);
  const manifest = structuredClone(current.manifest);
  const addedRanges = new Set([
    '192.88.99.2/32',
    '64:ff9b::/96',
    '100:0:0:1::/64',
    '2001::/32',
    '2001:2::/48',
    '3fff::/20',
    '5f00::/16',
  ]);
  config.route.rules[2].ip_cidr = config.route.rules[2].ip_cidr
    .filter((cidr) => !addedRanges.has(cidr));
  const configBytes = serialized(config);
  manifest.files['sing-box.json'] = manifestRecord(configBytes);
  await writeFile(path.join(current.path, 'sing-box.json'), configBytes);
  await writeFile(path.join(current.path, 'manifest.json'), serialized(manifest));
  return current.id;
}

async function restorePreviousNat64DenySet(repository) {
  const current = await repository.readCurrent();
  const config = structuredClone(current.config);
  const manifest = structuredClone(current.manifest);
  config.route.rules[2].ip_cidr = config.route.rules[2].ip_cidr
    .filter((cidr) => cidr !== '64:ff9b::/96');
  const configBytes = serialized(config);
  manifest.files['sing-box.json'] = manifestRecord(configBytes);
  await writeFile(path.join(current.path, 'sing-box.json'), configBytes);
  await writeFile(path.join(current.path, 'manifest.json'), serialized(manifest));
  return current.id;
}

test('fresh bootstrap validates first, publishes revision one, and writes only the admin handoff secret', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    const events = [];
    const calls = [];
    class RecordingRepository extends RevisionRepository {
      async initialize(...args) {
        events.push('initialize');
        return super.initialize(...args);
      }
    }
    const repository = new RecordingRepository(env.DATA_DIR);
    let randomByte = 0;
    const result = await bootstrap({
      env,
      repository,
      execFileImpl: keyGenerator(calls),
      validateConfigImpl: async (candidatePath) => {
        const config = JSON.parse(await readFile(candidatePath, 'utf8'));
        assert.equal(config.route.final, 'ts-out');
        assert.equal(config.inbounds[0].listen_port, 8443);
        const healthInbound = config.inbounds.find((inbound) => inbound.tag === 'health-in');
        assert.equal(healthInbound.users.length, 1);
        assert.equal(healthInbound.users[0].username, 'vpn-health');
        assert.equal(Buffer.from(healthInbound.users[0].password, 'base64url').length, 32);
        events.push('check');
      },
      randomBytesImpl: (size) => Buffer.alloc(size, ++randomByte),
      now: '2026-09-04T01:00:00.000Z',
    });

    assert.deepEqual(events, ['check', 'initialize']);
    assert.equal(result.status, 'initialized');
    assert.equal(result.revision, 1);
    assert.equal(Object.hasOwn(result, 'initialUser'), false);
    assert.deepEqual(calls.map(({ command, args }) => [command, args]), [[
      '/usr/bin/sing-box',
      ['generate', 'reality-keypair'],
    ]]);

    const current = await repository.readCurrent();
    assert.equal(current.state.users.length, 0);
    assert.equal(current.state.gateway.advertisedPort, 443);
    assert.equal(current.state.gateway.listenPort, 8443);
    assert.equal(current.state.tailscale.authKey, 'tskey-auth-bootstrap-test');
    assert.equal(current.state.tailscale.apiKey, null);
    assert.equal(current.state.health.username, 'vpn-health');
    assert.deepEqual(current.state.health.target, { host: 'www.example.com', port: 443 });
    assert.equal(Buffer.from(current.state.health.password, 'base64url').length, 32);
    assert.equal(
      current.state.health.password,
      current.config.inbounds.find((inbound) => inbound.tag === 'health-in').users[0].password,
    );
    assert.equal(JSON.stringify(current.state).includes('admin-secret'), false);
    assert.equal(JSON.parse(await readFile(env.SINGBOX_CONFIG, 'utf8')).route.final, 'ts-out');

    const secretPath = path.join(env.DATA_DIR, 'admin-secret');
    assert.equal((await lstat(secretPath)).mode & 0o777, 0o600);
    const secret = (await readFile(secretPath, 'utf8')).trimEnd();
    assert.equal(Buffer.from(secret, 'base64url').length, 32);
    assert.equal(await verifyAdminPassword(secret, current.state.admin.scrypt), true);
  });
});

test('fresh bootstrap rejects the reserved REALITY origin placeholder', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    env.SERVER_NAME = 'replace-with-an-authorized-origin.example';
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');

    await assert.rejects(
      bootstrap({
        env,
        execFileImpl: keyGenerator([]),
        validateConfigImpl: async () => {},
        randomBytesImpl: (size) => Buffer.alloc(size, 1),
        now: '2026-09-04T01:00:00.000Z',
      }),
      (error) => error?.code === 'PLACEHOLDER_CONFIGURATION',
    );
  });
});

test('initialized bootstrap is idempotent and does not read bootstrap settings or rotate secrets', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      execFileImpl: keyGenerator([]),
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const secretPath = path.join(env.DATA_DIR, 'admin-secret');
    const before = await readFile(secretPath);

    const result = await bootstrap({
      env: { DATA_DIR: env.DATA_DIR, VPS_HOST: 'not a host / and should be ignored' },
      execFileImpl: async () => { throw new Error('must not execute'); },
      validateConfigImpl: async () => { throw new Error('must not validate'); },
    });
    assert.equal(result.status, 'existing');
    assert.equal(result.revision, 1);
    assert.deepEqual(await readFile(secretPath), before);
  });
});

test('bootstrap refuses to create a second authority over committed revisions with no pointers', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      execFileImpl: keyGenerator([]),
      validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, 7),
      now: '2026-09-04T01:00:00.000Z',
    });
    const revisionsPath = path.join(env.DATA_DIR, 'revisions');
    const before = (await readdir(revisionsPath)).filter((name) => /^\d{16}-[0-9a-f]{16}$/u.test(name));
    assert.equal(before.length, 1);
    await unlink(path.join(env.DATA_DIR, 'current'));
    await unlink(path.join(env.DATA_DIR, 'runtime'));
    await unlink(env.TS_AUTH_KEY_FILE);

    let generated = false;
    await assert.rejects(
      bootstrap({
        env: { DATA_DIR: env.DATA_DIR },
        execFileImpl: async () => { generated = true; },
        validateConfigImpl: async () => { throw new Error('must not validate'); },
        randomBytesImpl: () => { throw new Error('must not generate credentials'); },
      }),
      (error) => error?.code === 'ORPHANED_REVISION',
    );
    assert.equal(generated, false);
    const after = (await readdir(revisionsPath)).filter((name) => /^\d{16}-[0-9a-f]{16}$/u.test(name));
    assert.deepEqual(after, before);
  });
});

test('bootstrap narrowly upgrades the previous v2 policy and converges across pointer crashes', async (t) => {
  for (const boundary of ['before-runtime', 'after-runtime', 'after-current']) {
    await t.test(boundary, async () => temporary(async (parent) => {
      const dataDir = path.join(parent, 'data');
      const original = new RevisionRepository(dataDir);
      const oldRevision = await original.initialize(fixtureState(), { operation: 'bootstrap' });
      await rewriteAsPreviousV2(original);
      await assert.rejects(
        new RevisionRepository(dataDir).readCurrent(),
        (error) => error?.code === 'INVALID_REVISION',
      );

      const repository = new RevisionRepository(dataDir, { allowPolicyUpgrade: true });
      const legacy = await repository.readCurrent();
      assert.equal(legacy.requiresPolicyUpgrade, true);
      let injected = false;
      const activateRuntime = repository.activateRuntime.bind(repository);
      const activateCurrent = repository.activateCurrent.bind(repository);
      repository.activateRuntime = async (id) => {
        if (!injected && boundary === 'before-runtime') {
          injected = true;
          throw new Error('simulated policy-upgrade crash');
        }
        const result = await activateRuntime(id);
        if (!injected && boundary === 'after-runtime') {
          injected = true;
          throw new Error('simulated policy-upgrade crash');
        }
        return result;
      };
      repository.activateCurrent = async (id) => {
        const result = await activateCurrent(id);
        if (!injected && boundary === 'after-current') {
          injected = true;
          throw new Error('simulated policy-upgrade crash');
        }
        return result;
      };

      let checks = 0;
      const options = {
        env: { DATA_DIR: dataDir, SINGBOX_BIN: '/usr/bin/sing-box' },
        repository,
        validateConfigImpl: async () => { checks += 1; },
      };
      await assert.rejects(bootstrap(options), /simulated policy-upgrade crash/u);
      const result = await bootstrap(options);
      assert.equal(['upgraded', 'existing'].includes(result.status), true);
      assert.equal(checks >= 1, true);

      const strict = new RevisionRepository(dataDir);
      const current = await strict.readCurrent();
      assert.equal(current.requiresPolicyUpgrade, false);
      assert.equal(current.state.revision, 2);
      assert.deepEqual(current.state.health.target, { host: 'www.example.com', port: 443 });
      assert.equal(current.config.route.rules[0].action, 'resolve');
      assert.equal(current.config.route.rules[1].action, 'reject');
      assert.equal(current.config.route.rules[2].ip_cidr.includes('100.64.0.0/10'), true);
      assert.equal(await strict.readPointer('runtime'), current.id);
      assert.equal((await strict.listRevisions()).length, 2);
      await assert.rejects(strict.readRevision(oldRevision.id), (error) => error?.code === 'INVALID_REVISION');
    }));
  }
});

test('bootstrap compatibility rejects a manifest-authenticated old config with extra authority', async () => {
  await temporary(async (parent) => {
    const dataDir = path.join(parent, 'data');
    const original = new RevisionRepository(dataDir);
    await original.initialize(fixtureState(), { operation: 'bootstrap' });
    await rewriteAsPreviousV2(original, (config) => {
      config.outbounds = [{ type: 'direct', tag: 'direct' }];
    });
    const repository = new RevisionRepository(dataDir, { allowPolicyUpgrade: true });
    await assert.rejects(repository.readCurrent(), (error) => error?.code === 'INVALID_REVISION');
  });
});

test('bootstrap upgrades the previous routed-DNS v2 policy with Tailnet isolation', async () => {
  await temporary(async (parent) => {
    const dataDir = path.join(parent, 'data');
    const original = new RevisionRepository(dataDir);
    await original.initialize(fixtureState(), { operation: 'bootstrap' });
    await removePreviousV2IsolationRules(original);

    const repository = new RevisionRepository(dataDir, { allowPolicyUpgrade: true });
    assert.equal((await repository.readCurrent()).requiresPolicyUpgrade, true);
    const result = await bootstrap({
      env: { DATA_DIR: dataDir, SINGBOX_BIN: '/usr/bin/sing-box' },
      repository,
      validateConfigImpl: async () => {},
    });
    assert.equal(result.status, 'upgraded');
    const current = await new RevisionRepository(dataDir).readCurrent();
    assert.equal(current.state.revision, 2);
    assert.deepEqual(current.config.route.rules.map((rule) => rule.action), [
      'resolve',
      'reject',
      'reject',
    ]);
  });
});

test('bootstrap upgrades the previous special-use deny set without accepting other route changes', async () => {
  await temporary(async (parent) => {
    const dataDir = path.join(parent, 'data');
    const original = new RevisionRepository(dataDir);
    await original.initialize(fixtureState(), { operation: 'bootstrap' });
    const previousId = await restorePreviousSpecialUseDenySet(original);

    const repository = new RevisionRepository(dataDir, { allowPolicyUpgrade: true });
    assert.equal((await repository.readCurrent()).requiresPolicyUpgrade, true);
    const result = await bootstrap({
      env: { DATA_DIR: dataDir, SINGBOX_BIN: '/usr/bin/sing-box' },
      repository,
      validateConfigImpl: async () => {},
    });
    assert.equal(result.status, 'upgraded');
    const current = await new RevisionRepository(dataDir).readCurrent();
    assert.equal(current.state.revision, 2);
    assert.equal(current.config.route.rules[2].ip_cidr.includes('5f00::/16'), true);
    await assert.rejects(
      new RevisionRepository(dataDir).readRevision(previousId),
      (error) => error?.code === 'INVALID_REVISION',
    );

    const tampered = structuredClone(current.config);
    tampered.route.rules[2].ip_cidr = tampered.route.rules[2].ip_cidr
      .filter((cidr) => cidr !== '5f00::/16');
    tampered.route.rules[1].action = 'route';
    assert.throws(
      () => assertLegacyV2Config(tampered, current.state),
      /exact predecessor isolation policy/u,
    );
  });
});

test('bootstrap upgrades the previous NAT64 policy without widening compatibility', async () => {
  await temporary(async (parent) => {
    const dataDir = path.join(parent, 'data');
    const original = new RevisionRepository(dataDir);
    await original.initialize(fixtureState(), { operation: 'bootstrap' });
    await restorePreviousNat64DenySet(original);

    const repository = new RevisionRepository(dataDir, { allowPolicyUpgrade: true });
    assert.equal((await repository.readCurrent()).requiresPolicyUpgrade, true);
    const result = await bootstrap({
      env: { DATA_DIR: dataDir, SINGBOX_BIN: '/usr/bin/sing-box' },
      repository,
      validateConfigImpl: async () => {},
    });
    assert.equal(result.status, 'upgraded');
    const current = await new RevisionRepository(dataDir).readCurrent();
    assert.equal(current.state.revision, 2);
    assert.equal(current.config.route.rules[2].ip_cidr.includes('64:ff9b::/96'), true);

    const tampered = structuredClone(current.config);
    tampered.route.rules[2].ip_cidr = tampered.route.rules[2].ip_cidr
      .filter((cidr) => cidr !== '64:ff9b::/96');
    tampered.route.rules[0].server = 'bootstrap-dns';
    assert.throws(
      () => assertLegacyV2Config(tampered, current.state),
      /exact predecessor isolation policy/u,
    );
  });
});

test('routed recovery scrubs credentials and retires every previous-policy revision', async () => {
  await temporary(async (parent) => {
    const dataDir = path.join(parent, 'data');
    const original = new RevisionRepository(dataDir);
    const old = await original.initialize(fixtureState(), { operation: 'bootstrap' });
    await rewriteAsPreviousV2(original);
    const bootstrapRepository = new RevisionRepository(dataDir, { allowPolicyUpgrade: true });
    const upgraded = await bootstrap({
      env: { DATA_DIR: dataDir, SINGBOX_BIN: '/usr/bin/sing-box' },
      repository: bootstrapRepository,
      validateConfigImpl: async () => {},
    });
    assert.equal(upgraded.status, 'upgraded');

    const repository = new RevisionRepository(dataDir);
    const runtime = { restart: async () => {}, probe: async () => true };
    const controller = new GatewayController({
      repository,
      runtime,
      validateConfig: async () => {},
      now: () => new Date('2026-09-04T00:01:00.000Z'),
    });
    const ready = await controller.recover();
    assert.equal(ready.state.tailscale.authKey, null);
    assert.equal(ready.state.tailscale.apiKey, null);
    assert.equal(controller.ready, true);
    assert.equal((await repository.listRevisions()).length, 1);
    await assert.rejects(repository.readRevision(old.id), (error) => error?.code === 'REVISION_NOT_FOUND');
  });
});

test('exclusive startup removes recent revision staging and raw config-check crash orphans', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      execFileImpl: keyGenerator([]),
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
    await chmod(path.join(stage, 'sing-box.json'), 0o640);

    const result = await bootstrap({ env: { DATA_DIR: env.DATA_DIR } });
    assert.equal(result.status, 'existing');
    await assert.rejects(lstat(rawOrphan), (error) => error.code === 'ENOENT');
    await assert.rejects(lstat(stage), (error) => error.code === 'ENOENT');
  });
});

test('startup refuses an unsafe bootstrap-config orphan instead of deleting it', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      execFileImpl: keyGenerator([]),
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

test('bootstrap completes a crash after the runtime pointer without rereading secrets', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      execFileImpl: keyGenerator([]),
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    await unlink(path.join(env.DATA_DIR, 'current'));
    const recovered = await bootstrap({ env: { DATA_DIR: env.DATA_DIR } });
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.revision, 1);
    assert.equal(
      await new RevisionRepository(env.DATA_DIR).readPointer('current'),
      await new RevisionRepository(env.DATA_DIR).readPointer('runtime'),
    );
  });
});

test('bootstrap restores the authoritative current pointer after an interrupted transaction', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      execFileImpl: keyGenerator([]),
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const repository = new RevisionRepository(env.DATA_DIR);
    const authoritative = await repository.readCurrent();
    const candidateState = {
      ...authoritative.state,
      revision: authoritative.state.revision + 1,
      updatedAt: '2026-09-04T01:01:00.000Z',
      gateway: { ...authoritative.state.gateway, publicBaseUrl: 'https://uncommitted.example' },
    };
    const candidate = await repository.createRevision(candidateState, { operation: 'test.interrupted' });
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

test('a rejected sing-box candidate leaves no admin secret, pointer, or temporary config', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await assert.rejects(bootstrap({
      env,
      execFileImpl: keyGenerator([]),
      validateConfigImpl: async () => { throw new Error('candidate rejected'); },
      now: '2026-09-04T01:00:00.000Z',
    }), (error) => error.code === 'CONFIG_REJECTED');
    const entries = await readdir(env.DATA_DIR);
    assert.equal(entries.includes('admin-secret'), false);
    assert.equal(entries.includes('current'), false);
    assert.equal(entries.some((name) => name.startsWith('.bootstrap-config-')), false);
  });
});

test('direct secret environment variables cannot substitute for required secret files', async () => {
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
