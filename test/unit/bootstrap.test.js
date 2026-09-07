import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { chmod, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { bootstrap } from '../../src/state/bootstrap-service.js';
import { readSecretFile } from '../../src/state/bootstrap-files.js';
import { verifyAdminPassword } from '../../src/core/credentials.js';
import { RevisionRepository } from '../../src/state/repository.js';
import { temporary, privateFile, environment } from '../fixtures/bootstrap.js';

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
