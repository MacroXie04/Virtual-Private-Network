import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin/application.js';
import { createSubscriptionServer } from '../../src/http/subscription/application.js';
import { request, cookieValue } from '../helpers/admin-http.js';
import { projection } from '../helpers/subscription-http.js';

const TOKEN = 'P'.repeat(43);
const PUBLIC_HOST = 'admin.example.com';

async function portal(t, { localHttpOrigin = '', guardAdminBuckets = true } = {}) {
  const calls = { controller: [], global: 0, login: 0, authenticated: 0, mutation: 0 };
  const seen = [];
  const backend = createSubscriptionServer({
    port: 0, sharedHostname: PUBLIC_HOST,
    loadView: async () => projection(TOKEN), checkMaintenance: async () => false,
  });
  backend.server.on('request', (req) => seen.push({ method: req.method, path: req.url, headers: req.headers }));
  const upstream = await backend.listen();
  t.after(() => backend.close());
  const control = new Proxy({}, {
    get: (_target, method) => async () => {
      calls.controller.push(method);
      throw new Error('subscription request reached controller');
    },
  });
  const forbiddenBucket = (name) => ({ take() {
    calls[name] += 1;
    throw new Error(`subscription request spent administrator ${name} allowance`);
  } });
  const service = createAdminServer({
    host: '127.0.0.1', port: 0, publicHostname: PUBLIC_HOST,
    localHttpOrigin, subscriptionPort: upstream.port, control,
    ...(guardAdminBuckets ? {
      globalRateLimiter: forbiddenBucket('global'), loginRateLimiter: forbiddenBucket('login'),
      rateLimiter: forbiddenBucket('authenticated'), mutationRateLimiter: forbiddenBucket('mutation'),
    } : {}),
  });
  const address = await service.listen();
  t.after(() => service.close());
  return { address, calls, seen };
}

function assertNoAdministratorCalls(calls) {
  assert.deepEqual(calls, { controller: [], global: 0, login: 0, authenticated: 0, mutation: 0 });
}

test('administrator portal serves every subscription format and HEAD without sessions or administrator buckets', async (t) => {
  const { address, calls, seen } = await portal(t);
  const types = ['text/plain', 'text/plain', 'application/json', 'application/yaml'];
  for (const [index, format] of ['', '/links', '/sing-box', '/clash'].entries()) {
    const pathname = `/s/${TOKEN}${format}`;
    const get = await request(address, pathname, { headers: { host: PUBLIC_HOST } });
    const head = await request(address, pathname, { method: 'HEAD', headers: { host: PUBLIC_HOST } });
    assert.equal(get.status, 200);
    assert.ok(get.headers['content-type'].startsWith(types[index]));
    assert.equal(get.headers['cache-control'], 'no-store');
    assert.equal(get.headers['set-cookie'], undefined);
    assert.equal(get.headers.location, undefined);
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], String(Buffer.byteLength(get.body)));
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-disposition'], get.headers['content-disposition']);
    assert.equal(head.headers['set-cookie'], undefined);
  }
  assert.equal(seen.length, 8);
  assert.ok(seen.every((entry) => entry.headers.host === PUBLIC_HOST));
  assertNoAdministratorCalls(calls);
});

test('portal ignores administrator cookies for subscriptions and isolates invalid subscription traffic from administrator limits', async (t) => {
  const { address, calls, seen } = await portal(t);
  const headers = {
    host: PUBLIC_HOST, cookie: '__Host-vpn_admin_session=session_that_must_not_be_checked',
    authorization: 'Bearer private-admin-credential', origin: 'https://untrusted.example',
    forwarded: 'host=untrusted.example', 'x-forwarded-host': 'untrusted.example',
  };
  const accepted = await request(address, `/s/${TOKEN}/links`, { headers });
  assert.equal(accepted.status, 200);
  assert.match(accepted.body, /^vless:\/\//u);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].headers.origin, undefined);
  assert.equal(seen[0].headers.forwarded, undefined);
  assert.equal(seen[0].headers['x-forwarded-host'], undefined);
  for (const [pathname, method] of [
    [`/s/${'Q'.repeat(43)}`, 'GET'], ['/s', 'GET'], ['/s/short', 'GET'], ['/s/%2f', 'GET'],
    [`/s/${TOKEN}/unsupported`, 'GET'], [`/s/${TOKEN}?format=links`, 'GET'],
    [`/s/${TOKEN}`, 'POST'], [`/s/${TOKEN}`, 'DELETE'],
  ]) {
    assert.equal((await request(address, pathname, { method, headers })).status, 404);
  }
  assert.equal(seen.length, 2, 'only syntactically valid token requests may reach the subscription worker');
  assertNoAdministratorCalls(calls);
});

test('portal rejects wrong subscription Host without accepting forwarded authority or touching the controller', async (t) => {
  const { address, calls, seen } = await portal(t);
  for (const host of ['other.example.com', 'sub.example.com', `${PUBLIC_HOST}:443`, '127.0.0.1:8081']) {
    const response = await request(address, `/s/${TOKEN}/links`, {
      headers: { host, 'x-forwarded-host': PUBLIC_HOST, forwarded: `host=${PUBLIC_HOST}` },
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers.location, undefined);
    assert.doesNotMatch(response.body, /vless:\/\//u);
  }
  assert.equal(seen.length, 0);
  assertNoAdministratorCalls(calls);
});

test('management paths still require administrator login on the unified portal', async (t) => {
  const { address, calls, seen } = await portal(t, { guardAdminBuckets: false });
  for (const pathname of ['/', '/exit-nodes', '/users', '/healthz', '/users/alice/export']) {
    const response = await request(address, pathname, { headers: { host: PUBLIC_HOST } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/login');
  }
  for (const pathname of ['/account', '/account/downloads/links', '/account/password-changed']) {
    const response = await request(address, pathname, { headers: { host: PUBLIC_HOST } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/account/login');
  }
  const accountLogin = await request(address, '/account/login', { headers: { host: PUBLIC_HOST } });
  assert.equal(accountLogin.status, 200);
  assert.ok(cookieValue(accountLogin.headers['set-cookie'], '__Host-vpn_account_login_csrf'));
  const login = await request(address, '/login', { headers: { host: PUBLIC_HOST } });
  assert.equal(login.status, 200);
  assert.match(login.headers['content-type'], /text\/html/u);
  assert.match(login.body, /name="csrf"/u);
  assert.ok(cookieValue(login.headers['set-cookie'], '__Host-vpn_admin_login_csrf'));
  assert.match(login.headers['set-cookie'][0], /; Secure/u);
  assert.equal((await request(address, '/login', { headers: { host: 'other.example.com' } })).status, 403);
  assert.equal(seen.length, 0);
  assert.deepEqual(calls.controller, []);
});

test('explicit local HTTP portal checks its local Host and rewrites only the backend Host to the public authority', async (t) => {
  const localHttpOrigin = 'http://127.0.0.1:8081';
  const { address, calls, seen } = await portal(t, { localHttpOrigin });
  // The listener uses an ephemeral test port; Host models the configured browser-facing origin.
  const headers = {
    host: '127.0.0.1:8081', origin: localHttpOrigin,
    cookie: 'vpn_admin_session_local=local_session_that_must_not_be_checked',
  };
  const get = await request(address, `/s/${TOKEN}/links`, { headers });
  const head = await request(address, `/s/${TOKEN}/links`, { method: 'HEAD', headers });
  assert.equal(get.status, 200);
  assert.match(get.body, /^vless:\/\//u);
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(get.headers['set-cookie'], undefined);
  assert.deepEqual(seen.map((entry) => entry.headers.host), [PUBLIC_HOST, PUBLIC_HOST]);
  assert.ok(seen.every((entry) => !entry.headers.cookie && !entry.headers.origin));
  for (const host of [PUBLIC_HOST, '127.0.0.1:8082', 'localhost:8081']) {
    assert.equal((await request(address, `/s/${TOKEN}`, { headers: { ...headers, host } })).status, 403);
  }
  assert.equal(seen.length, 2);
  assertNoAdministratorCalls(calls);
});
