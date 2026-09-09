import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSubscriptionServer } from '../../src/http/subscription/application.js';

import { request, projection, tokenHash } from '../helpers/subscription-http.js';

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
  assert.match(Buffer.from(mixed.body.toString(), 'base64').toString(), /@vpn\.example\.com:443/u);
  assert.equal(mixed.headers['cache-control'], 'no-store');

  const links = await request(address, `/s/${token}/links`);
  const head = await request(address, `/s/${token}/links`, { method: 'HEAD' });
  assert.equal(links.status, 200);
  assert.match(links.body.toString(), /^vless:\/\//u);
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], links.headers['content-length']);

  const singBox = await request(address, `/s/${token}/sing-box`);
  assert.equal(JSON.parse(singBox.body).outbounds[0].server, 'vpn.example.com');
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
  assert.equal((await request(address, `/s/${token}/links`, {
    headers: { Host: 'vpn.example.com', 'x-forwarded-host': 'sub.example.com' },
  })).status, 404);
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
