import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubscriptionProxy } from '../../src/http/admin/subscriptions.js';
import { createSubscriptionServer } from '../../src/http/subscription/application.js';
import { parseOriginForm } from '../../src/http/shared/input.js';
import { createHttpService, sendGenericError, sendResponse } from '../../src/http/shared/service.js';
import { projection, request } from '../helpers/subscription-http.js';

async function frontend(t, port) {
  const proxy = createSubscriptionProxy({ publicHostname: 'admin.example.com', port });
  const service = createHttpService(async (req, res) => {
    if (!await proxy(req, res, parseOriginForm(req.url))) sendGenericError(req, res, 404);
  }, { port: 0 });
  const address = await service.listen();
  t.after(() => service.close());
  return address;
}

test('unified subscription proxy preserves all formats and HEAD without administrator authentication', async (t) => {
  const token = 'A'.repeat(43);
  const backend = createSubscriptionServer({
    port: 0, sharedHostname: 'admin.example.com',
    loadView: async () => projection(token), checkMaintenance: async () => false,
  });
  const upstream = await backend.listen();
  t.after(() => backend.close());
  const address = await frontend(t, upstream.port);
  const types = ['text/plain', 'text/plain', 'application/json', 'application/yaml'];
  for (const [index, format] of ['', '/links', '/sing-box', '/clash'].entries()) {
    const pathname = `/s/${token}${format}`;
    const get = await request(address, pathname, { headers: { Host: 'admin.example.com' } });
    const head = await request(address, pathname, { method: 'HEAD', headers: { Host: 'admin.example.com' } });
    assert.equal(get.status, 200);
    assert.ok(get.headers['content-type'].startsWith(types[index]));
    assert.equal(get.headers['cache-control'], 'no-store');
    assert.equal(get.headers['set-cookie'], undefined);
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-disposition'], get.headers['content-disposition']);
  }
  const unknown = await request(address, `/s/${'B'.repeat(43)}`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.toString(), 'Not Found\n');
});

test('proxy has a fixed destination and does not forward client credentials or upstream cookies', async (t) => {
  const seen = [];
  const backend = createHttpService((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    sendResponse(req, res, 200, 'subscription', {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="vless-links.txt"',
      'set-cookie': 'upstream-secret=blocked', authorization: 'blocked',
      location: 'https://attacker.invalid/', 'x-private': 'blocked',
    });
  }, { port: 0 });
  const upstream = await backend.listen();
  t.after(() => backend.close());
  const address = await frontend(t, upstream.port);
  const pathname = `/s/${'C'.repeat(43)}/links`;
  const response = await request(address, pathname, { headers: {
    Host: 'admin.example.com', Cookie: '__Host-vpn_admin_session=private-session',
    Authorization: 'Bearer private-credential', Forwarded: 'host=attacker.invalid',
    'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-For': '192.0.2.1',
    'Proxy-Authorization': 'private-proxy-credential', Origin: 'https://admin.example.com',
  } });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), 'subscription');
  assert.equal(response.headers['content-disposition'], 'attachment; filename="vless-links.txt"');
  assert.equal(seen.length, 1);
  assert.deepEqual({ ...seen[0].headers }, { host: 'admin.example.com', connection: 'close' });
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, pathname);
  for (const name of ['set-cookie', 'authorization', 'location', 'x-private']) {
    assert.equal(response.headers[name], undefined);
  }
});

test('invalid subscription routes never reach the backend', async (t) => {
  let calls = 0;
  const backend = createHttpService((req, res) => { calls += 1; sendResponse(req, res, 200, 'unexpected'); }, { port: 0 });
  const upstream = await backend.listen();
  t.after(() => backend.close());
  const address = await frontend(t, upstream.port);
  const base = `/s/${'D'.repeat(43)}`;
  for (const [pathname, method] of [
    ['/s', 'GET'], ['/s/short', 'GET'], [`${base}/other`, 'GET'], [`${base}?format=links`, 'GET'],
    [base, 'POST'], [base, 'PUT'], [`${base}/links/extra`, 'GET'], ['/not-subscription', 'GET'],
  ]) {
    assert.equal((await request(address, pathname, { method })).status, 404);
  }
  assert.equal(calls, 0);
});

test('maintenance and credential rate limits retain status and Retry-After through the unified entry', async (t) => {
  let maintenance = true;
  const backend = createSubscriptionServer({
    port: 0, sharedHostname: 'admin.example.com', loadView: async () => projection('E'.repeat(43)),
    checkMaintenance: async () => maintenance,
    rateLimiter: { take: () => ({ allowed: false, retryAfter: 17 }) },
  });
  const upstream = await backend.listen();
  t.after(() => backend.close());
  const address = await frontend(t, upstream.port);
  const pending = await request(address, `/s/${'E'.repeat(43)}`);
  assert.equal(pending.status, 503);
  assert.equal(pending.headers['retry-after'], '1');
  maintenance = false;
  const limited = await request(address, `/s/${'E'.repeat(43)}`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '17');
});
