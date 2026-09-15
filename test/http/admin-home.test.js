import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin/application.js';
import { ControlError } from '../../src/control/socket/client-transport.js';
import { FixedWindowRateLimiter } from '../../src/http/shared/rate-limit.js';
import { request, cookieValue } from '../helpers/admin-http.js';

const VALID = 'verified-administrator-session';
const forbidden = (name) => ({ take() { throw new Error(`the home page spent the ${name} bucket`); } });
const limiter = () => new FixedWindowRateLimiter({ limit: 100, windowMs: 60_000, maxEntries: 8 });

/** Records every controller method the server touches and refuses all of them. */
function recordingControl(calls) {
  return new Proxy({}, {
    get: (_target, method) => async () => {
      calls.push(method);
      throw new Error(`home page reached the controller: ${String(method)}`);
    },
  });
}

function counting(inner) {
  const wrapper = { count: 0, take(key) { wrapper.count += 1; return inner.take(key); } };
  return wrapper;
}

async function server(t, { control, globalRateLimiter = limiter(), rateLimiter = forbidden('per-session') } = {}) {
  const service = createAdminServer({
    host: '127.0.0.1', port: 0, publicHostname: 'admin.test', control, globalRateLimiter, rateLimiter,
    loginRateLimiter: forbidden('login'), mutationRateLimiter: forbidden('mutation'),
    accountLoginSourceRateLimiter: forbidden('account sign-in source'), accountLoginRateLimiter: forbidden('account sign-in name'),
    accountRateLimiter: forbidden('account session'), accountMutationRateLimiter: forbidden('account mutation'),
  });
  const address = await service.listen();
  t.after(() => service.close());
  return address;
}

test('the site root and the stylesheet are constant public responses served from the anonymous bucket alone', async (t) => {
  const calls = [];
  const global = counting(limiter());
  const address = await server(t, { control: recordingControl(calls), globalRateLimiter: global });
  const get = await request(address, '/');
  assert.equal(get.status, 200);
  assert.match(get.headers['content-type'], /^text\/html/u);
  assert.equal(get.headers['referrer-policy'], 'same-origin');
  assert.equal(get.headers['cache-control'], 'no-store');
  assert.match(get.headers['content-security-policy'], /default-src 'none'/u);
  assert.equal(get.headers['x-frame-options'], 'DENY');
  assert.equal(get.headers['set-cookie'], undefined);
  assert.equal(get.headers.location, undefined);
  assert.match(get.body, /<title>VPN Gateway<\/title>/u);
  assert.deepEqual([...get.body.matchAll(/href="([^"]*)"/gu)].map((match) => match[1]), ['/assets/admin.css', '/account', '/overview']);
  assert.doesNotMatch(get.body, /<script|<form|name="csrf"|Gateway overview|Sign out|admin\.test/iu);
  const head = await request(address, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(get.body)));
  assert.equal(head.headers['content-type'], get.headers['content-type']);
  assert.equal(head.headers['set-cookie'], undefined);
  assert.equal((await request(address, '/')).body, get.body);
  const css = await request(address, '/assets/admin.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/u);
  assert.equal(css.headers['set-cookie'], undefined);
  const cssHead = await request(address, '/assets/admin.css', { method: 'HEAD' });
  assert.equal(cssHead.status, 200);
  assert.equal(cssHead.body, '');
  assert.equal(cssHead.headers['content-length'], String(Buffer.byteLength(css.body)));
  assert.equal(global.count, 5);
  assert.deepEqual(calls, []);
});

test('only GET and HEAD of the exact root are public; other methods, spellings and hosts keep their existing answers', async (t) => {
  const calls = [];
  const address = await server(t, { control: recordingControl(calls) });
  const post = await request(address, '/', { method: 'POST', headers: { origin: 'https://admin.test' } });
  assert.equal(post.status, 404);
  assert.equal(post.headers['set-cookie'], undefined);
  assert.equal((await request(address, '/', { method: 'POST' })).status, 403);
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    assert.equal((await request(address, '/', { method })).status, 404);
  }
  for (const pathname of ['/overview', '/users', '/exit-nodes']) {
    const response = await request(address, pathname);
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/login');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  for (const pathname of ['/index.html', '/home', '/healthz', '/robots.txt']) {
    const response = await request(address, pathname);
    assert.equal(response.status, 404);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal((await request(address, '/?x=1')).status, 400);
  assert.equal((await request(address, '/', { headers: { origin: 'https://hostile.test' } })).status, 403);
  const foreign = await request(address, '/', { headers: { host: 'other.test' } });
  assert.equal(foreign.status, 403);
  assert.doesNotMatch(foreign.body, /Sign in to your account/u);
  assert.deepEqual(calls, []);
});

test('no cookie is read or cleared at the root, whatever realm or shape it has', async (t) => {
  const calls = [];
  const address = await server(t, { control: recordingControl(calls) });
  const login = await request(address, '/login');
  const loginCsrf = cookieValue(login.headers['set-cookie'], '__Host-vpn_admin_login_csrf');
  assert.ok(loginCsrf);
  const cookies = [
    loginCsrf,
    `__Host-vpn_admin_session=${VALID}`,
    `__Host-vpn_admin_session=${'s'.repeat(32)}`,
    `__Host-vpn_admin_session=${'x'.repeat(8)}`,
    `__Host-vpn_admin_session=${'y'.repeat(513)}`,
    `__Host-vpn_account_session=${'a'.repeat(32)}`,
    `__Host-vpn_admin_session=${VALID}; __Host-vpn_account_session=${'a'.repeat(32)}`,
  ];
  for (const cookie of cookies) {
    for (const method of ['GET', 'HEAD']) {
      const home = await request(address, '/', { method, headers: { cookie } });
      assert.equal(home.status, 200);
      assert.equal(home.headers['set-cookie'], undefined);
      if (method === 'GET') assert.match(home.body, /Sign in to your account/u);
      else assert.equal(home.body, '');
    }
  }
  assert.deepEqual(calls, []);
});

test('the dashboard lives at /overview behind the administrator session pipeline', async (t) => {
  let outage = false;
  const control = {
    checkSession: async (sessionId) => {
      if (outage) throw new ControlError('UNAVAILABLE', 503);
      if (sessionId !== VALID) throw new ControlError('UNAUTHORIZED', 401);
    },
    snapshot: async () => ({ revision: 1, csrf: 'csrf', ready: true, users: [], exitNodes: [], gateway: {} }),
  };
  const address = await server(t, { control, rateLimiter: limiter() });
  for (const method of ['GET', 'HEAD']) {
    const stale = await request(address, '/overview', { method, headers: { cookie: `__Host-vpn_admin_session=${'s'.repeat(32)}` } });
    assert.equal(stale.status, 303);
    assert.equal(stale.headers.location, '/login');
    assert.equal(stale.headers['set-cookie'].length, 1);
    assert.match(stale.headers['set-cookie'][0], /^__Host-vpn_admin_session=; .*Max-Age=0$/u);
  }
  const dashboard = await request(address, '/overview', { headers: { cookie: `__Host-vpn_admin_session=${VALID}` } });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /<a href="\/overview" aria-current="page">Overview<\/a>[\s\S]*Gateway overview/u);
  assert.doesNotMatch(dashboard.body, /Sign in to your account/u);
  const dashboardHead = await request(address, '/overview', { method: 'HEAD', headers: { cookie: `__Host-vpn_admin_session=${VALID}` } });
  assert.equal(dashboardHead.status, 200);
  assert.equal(dashboardHead.body, '');
  assert.equal(dashboardHead.headers['content-length'], String(Buffer.byteLength(dashboard.body)));
  outage = true;
  assert.equal((await request(address, '/overview', { headers: { cookie: `__Host-vpn_admin_session=${VALID}` } })).status, 503);
  const anonymous = await request(address, '/');
  assert.equal(anonymous.status, 200);
  assert.doesNotMatch(anonymous.body, /Gateway overview|Request failed/u);
});
