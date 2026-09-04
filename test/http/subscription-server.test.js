import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSubscriptionServer, readSubscriptionView } from '../../src/subscription-server.js';
import { FixedWindowRateLimiter } from '../../src/http-common.js';

function tokenHash(token) {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function request(address, requestPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: address.port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function projection(token, displayName = 'Alice') {
  return {
    schemaVersion: 1,
    revision: 1,
    gateway: { host: { kind: 'ipv6', value: '2001:db8::10' }, advertisedPort: 443 },
    reality: {
      serverName: 'www.example.com',
      publicKey: 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0',
      shortId: '01ab',
    },
    users: [{
      id: 'alice',
      displayName,
      uuid: '123e4567-e89b-42d3-a456-426614174000',
      tokenHash: tokenHash(token),
    }],
  };
}

test('subscription server exposes only explicit token routes with identical absent-token failures', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-sub-test-'));
  const current = path.join(directory, 'current');
  await mkdir(current);
  const projectionPath = path.join(current, 'subscription-view.json');
  const token = 'A'.repeat(43);
  await writeFile(projectionPath, JSON.stringify(projection(token, 'Alice: # one')), { mode: 0o600 });
  const service = createSubscriptionServer({ dataDir: directory, host: '127.0.0.1', port: 0 });
  const address = await service.listen();
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });

  const mixed = await request(address, `/s/${token}`);
  assert.equal(mixed.status, 200);
  assert.match(Buffer.from(mixed.body.toString(), 'base64').toString(), /^vless:\/\//u);
  assert.match(Buffer.from(mixed.body.toString(), 'base64').toString(), /@\[2001:db8::10\]:443/u);
  assert.equal(mixed.headers['cache-control'], 'no-store');

  const links = await request(address, `/s/${token}/links`);
  const head = await request(address, `/s/${token}/links`, { method: 'HEAD' });
  assert.equal(links.status, 200);
  assert.match(links.body.toString(), /^vless:\/\//u);
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], links.headers['content-length']);

  const singBox = await request(address, `/s/${token}/sing-box`);
  assert.equal(JSON.parse(singBox.body).outbounds[0].server, '2001:db8::10');
  const clash = await request(address, `/s/${token}/clash`);
  assert.match(clash.body.toString(), /name: "Alice: # one"/u);

  const unknown = await request(address, `/s/${'B'.repeat(43)}/links`);
  const revokedOrDisabled = await request(address, `/s/${'C'.repeat(43)}/links`);
  assert.equal(unknown.status, 404);
  assert.equal(revokedOrDisabled.status, 404);
  assert.deepEqual(unknown.body, revokedOrDisabled.body);
  assert.equal((await request(address, '/admin')).status, 404);
  assert.equal((await request(address, `/s/${token}/links`, { method: 'POST' })).status, 404);
  assert.equal((await request(address, `/s/${token}/links?format=other`)).status, 404);
});

test('subscription server rereads the projection for every request', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-sub-refresh-test-'));
  const current = path.join(directory, 'current');
  await mkdir(current);
  const projectionPath = path.join(current, 'subscription-view.json');
  const oldToken = 'D'.repeat(43);
  const newToken = 'E'.repeat(43);
  await writeFile(projectionPath, JSON.stringify(projection(oldToken)));
  const service = createSubscriptionServer({ dataDir: directory, host: '127.0.0.1', port: 0 });
  const address = await service.listen();
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal((await request(address, `/s/${oldToken}`)).status, 200);
  await writeFile(projectionPath, JSON.stringify({ ...projection(newToken), revision: 2 }));
  assert.equal((await request(address, `/s/${oldToken}`)).status, 404);
  assert.equal((await request(address, `/s/${newToken}`)).status, 200);
});

test('maintenance marker gates valid subscription routes before projection reads', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-sub-maintenance-test-'));
  const current = path.join(directory, 'current');
  await mkdir(current);
  const projectionPath = path.join(current, 'subscription-view.json');
  const markerPath = path.join(directory, 'maintenance');
  const token = 'F'.repeat(43);
  await writeFile(projectionPath, JSON.stringify(projection(token)));
  await writeFile(markerPath, 'switching\n', { mode: 0o600 });
  let projectionReads = 0;
  const service = createSubscriptionServer({
    dataDir: directory,
    host: '127.0.0.1',
    port: 0,
    loadView: async () => {
      projectionReads += 1;
      return readSubscriptionView(projectionPath);
    },
  });
  const address = await service.listen();
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });

  const maintenance = await request(address, `/s/${token}/links`);
  assert.equal(maintenance.status, 503);
  assert.equal(maintenance.headers['retry-after'], '1');
  assert.equal((await request(address, '/not-a-subscription')).status, 404);
  assert.equal(projectionReads, 0);

  await rm(markerPath);
  assert.equal((await request(address, `/s/${token}/links`)).status, 200);
  assert.equal(projectionReads, 1);
});

test('maintenance beginning during a projection read suppresses the credential response', async (t) => {
  const token = 'K'.repeat(43);
  let maintenanceChecks = 0;
  let projectionReads = 0;
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => {
      projectionReads += 1;
      return projection(token);
    },
    checkMaintenance: async () => {
      maintenanceChecks += 1;
      return maintenanceChecks > 1;
    },
  });
  const address = await service.listen();
  t.after(() => service.close());

  const response = await request(address, `/s/${token}/links`);
  assert.equal(response.status, 503);
  assert.equal(response.headers['retry-after'], '1');
  assert.equal(projectionReads, 1);
  assert.equal(maintenanceChecks, 2);
});

test('projection reader refuses a symlink in place of the immutable view file', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-sub-symlink-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const realPath = path.join(directory, 'real.json');
  const linkedPath = path.join(directory, 'subscription-view.json');
  await writeFile(realPath, JSON.stringify(projection('G'.repeat(43))));
  await symlink('real.json', linkedPath);
  await assert.rejects(readSubscriptionView(linkedPath), /subscription data unavailable/u);
});

test('two subscription tokens expose only their own user across every format', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-sub-isolation-test-'));
  const current = path.join(directory, 'current');
  await mkdir(current);
  const tokenA = 'H'.repeat(43);
  const tokenB = 'I'.repeat(43);
  const uuidA = '123e4567-e89b-42d3-a456-426614174001';
  const uuidB = '123e4567-e89b-42d3-a456-426614174002';
  const view = projection(tokenA, 'Alice private');
  view.users[0].uuid = uuidA;
  view.users.push({
    id: 'bob',
    displayName: 'Bob private',
    uuid: uuidB,
    tokenHash: tokenHash(tokenB),
  });
  await writeFile(path.join(current, 'subscription-view.json'), JSON.stringify(view), { mode: 0o600 });
  const service = createSubscriptionServer({ dataDir: directory, host: '127.0.0.1', port: 0 });
  const address = await service.listen();
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });

  for (const [token, ownUuid, otherUuid, ownName, otherName] of [
    [tokenA, uuidA, uuidB, 'Alice private', 'Bob private'],
    [tokenB, uuidB, uuidA, 'Bob private', 'Alice private'],
  ]) {
    for (const format of ['links', 'sing-box', 'clash']) {
      const response = await request(address, `/s/${token}/${format}`);
      assert.equal(response.status, 200);
      const text = response.body.toString('utf8');
      assert.match(text, new RegExp(ownUuid, 'u'));
      assert.doesNotMatch(text, new RegExp(otherUuid, 'u'));
      if (format !== 'sing-box') {
        assert.match(text, new RegExp(format === 'links' ? encodeURIComponent(ownName) : ownName, 'u'));
        assert.doesNotMatch(text, new RegExp(otherName, 'u'));
      } else {
        assert.doesNotMatch(text, new RegExp(ownName, 'u'));
        assert.doesNotMatch(text, new RegExp(otherName, 'u'));
      }
    }
    const mixed = await request(address, `/s/${token}`);
    assert.equal(mixed.status, 200);
    const decoded = Buffer.from(mixed.body.toString('utf8'), 'base64').toString('utf8');
    assert.match(decoded, new RegExp(ownUuid, 'u'));
    assert.doesNotMatch(decoded, new RegExp(otherUuid, 'u'));
    assert.match(decoded, new RegExp(encodeURIComponent(ownName), 'u'));
    assert.doesNotMatch(decoded, new RegExp(otherName, 'u'));
  }
});

test('subscription server enforces its request limiter with a real 429 response', async (t) => {
  const token = 'J'.repeat(43);
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => projection(token),
    checkMaintenance: async () => false,
    rateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 8,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  // Arbitrary paths use only the high global guard and cannot spend a valid
  // credential's own allowance.
  assert.equal((await request(address, '/not-a-subscription')).status, 404);
  assert.equal((await request(address, `/s/${token}/links`, {
    headers: { 'x-forwarded-for': '198.51.100.1' },
  })).status, 200);
  const limited = await request(address, `/s/${token}/links`, {
    headers: { 'x-forwarded-for': '198.51.100.2' },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(limited.body.toString('utf8'), 'Too Many Requests\n');
});

test('malformed aggregate throttling cannot block a verified subscription', async (t) => {
  const token = 'O'.repeat(43);
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => projection(token),
    checkMaintenance: async () => false,
    globalRateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 2,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  assert.equal((await request(address, '/not-a-subscription')).status, 404);
  assert.equal((await request(address, '/still-not-a-subscription')).status, 429);
  assert.equal((await request(address, `/s/${token}/links`)).status, 200);
});

test('valid subscription credentials have independent proxy-safe rate buckets', async (t) => {
  const tokenA = 'L'.repeat(43);
  const tokenB = 'M'.repeat(43);
  const view = projection(tokenA);
  view.users.push({
    id: 'bob',
    displayName: 'Bob',
    uuid: '123e4567-e89b-42d3-a456-426614174003',
    tokenHash: tokenHash(tokenB),
  });
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => view,
    checkMaintenance: async () => false,
    rateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 8,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  assert.equal((await request(address, `/s/${tokenA}/links`)).status, 200);
  assert.equal((await request(address, `/s/${tokenB}/links`)).status, 200);
  assert.equal((await request(address, `/s/${tokenA}/links`)).status, 429);
});

test('invalid-token floods cannot consume the bounded valid-credential limiter', async (t) => {
  const validToken = 'N'.repeat(43);
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => projection(validToken),
    checkMaintenance: async () => false,
    rateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 2,
      now: () => 1_000,
    }),
    invalidTokenRateLimiter: new FixedWindowRateLimiter({
      limit: 100,
      windowMs: 60_000,
      maxEntries: 2,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  for (let index = 0; index < 20; index += 1) {
    const guessed = `${String(index).padStart(2, '0')}${'G'.repeat(41)}`;
    assert.equal((await request(address, `/s/${guessed}/links`)).status, 404);
  }
  assert.equal((await request(address, `/s/${validToken}/links`)).status, 200);
  assert.equal((await request(address, `/s/${validToken}/links`)).status, 429);
});
