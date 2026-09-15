import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin/application.js';
import { validateLocalHttpOrigin } from '../../src/http/admin/site.js';
import { ControlError } from '../../src/control/socket/client-transport.js';
import { request, cookieValue, encoded } from '../helpers/admin-http.js';

const ORIGIN = 'http://127.0.0.1:18081';
const HOST = '127.0.0.1:18081';
const SESSION = 'local-administrator-session-value';
const CSRF = 'controller-local-csrf';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

test('local HTTP origins require canonical loopback spelling and an exact HTTP origin', () => {
  for (const origin of [ORIGIN, 'http://localhost:18081', 'http://[::1]:18081', 'http://localhost']) {
    assert.equal(validateLocalHttpOrigin(origin), origin);
  }
  for (const origin of [
    undefined, null, '', 'https://127.0.0.1:18081', 'ftp://localhost',
    'http://0.0.0.0:18081', 'http://192.168.1.2:18081', 'http://admin.example.com',
    'http://127.1:18081', 'http://2130706433:18081', 'http://0x7f000001:18081',
    'http://127.000.000.001:18081', 'http://[::ffff:127.0.0.1]:18081',
    'http://LOCALHOST:18081', 'http://localhost.:18081', 'http://localhost:80',
    `${ORIGIN}/`, `${ORIGIN}/login`, `${ORIGIN}?x=1`, `${ORIGIN}#fragment`,
    ` ${ORIGIN}`, `${ORIGIN}\n`, 'http://user:password@127.0.0.1:18081',
  ]) assert.throws(() => validateLocalHttpOrigin(origin), /LOCAL_HTTP_ORIGIN/u);
});

test('wildcard binding requires explicit valid local HTTP mode', () => {
  const options = { host: '0.0.0.0', port: 0, publicHostname: 'admin.example.com', control: {} };
  for (const localHttpOrigin of [undefined, '']) {
    assert.throws(() => createAdminServer({ ...options, localHttpOrigin }), /loopback/u);
  }
  for (const localHttpOrigin of ['http://0.0.0.0:18081', 'https://localhost:18081']) {
    assert.throws(() => createAdminServer({ ...options, localHttpOrigin }), /LOCAL_HTTP_ORIGIN/u);
  }
  assert.doesNotThrow(() => createAdminServer({ ...options, localHttpOrigin: ORIGIN }));
});

function assertLocalCookie(cookies, name) {
  const value = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(value);
  assert.match(value, /; HttpOnly(?:;|$)/u);
  assert.match(value, /; SameSite=Strict(?:;|$)/u);
  assert.match(value, /; Path=\/(?:;|$)/u);
  assert.doesNotMatch(value, /; Secure(?:;|$)|; Domain=/u);
}

test('local login requires matching Host, Origin and CSRF and uses separate non-Secure cookies', async (t) => {
  let logins = 0;
  let sessions = 0;
  const service = createAdminServer({
    host: '127.0.0.1', port: 0, publicHostname: 'admin.example.com', localHttpOrigin: ORIGIN,
    control: {
      login: async (secret) => {
        assert.equal(secret, 'synthetic-local-password');
        logins += 1;
        return { sessionId: SESSION, csrf: CSRF, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
      checkSession: async () => { sessions += 1; },
    },
  });
  const address = await service.listen();
  t.after(() => service.close());
  for (const host of ['localhost:18081', '127.0.0.1:18082', 'admin.example.com']) {
    assert.equal((await request(address, '/login', {
      headers: { host, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'http' },
    })).status, 403);
  }
  const page = await request(address, '/login', { headers: { host: HOST } });
  assert.equal(page.status, 200);
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assertLocalCookie(page.headers['set-cookie'], 'vpn_admin_login_csrf_local');
  const cookie = cookieValue(page.headers['set-cookie'], 'vpn_admin_login_csrf_local');
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(page.body)?.[1];
  assert.ok(csrf);
  const headers = { host: HOST, cookie, 'content-type': 'application/x-www-form-urlencoded' };
  const body = encoded({ csrf, secret: 'synthetic-local-password' });
  for (const origin of [undefined, '', 'null', 'http://localhost:18081', 'http://127.0.0.1:18082', [ORIGIN, ORIGIN]]) {
    assert.equal((await request(address, '/login', {
      method: 'POST', headers: { ...headers, ...(origin === undefined ? {} : { origin }) }, body,
    })).status, 403);
  }
  for (const override of [
    { body: encoded({ csrf: 'Z'.repeat(43), secret: 'synthetic-local-password' }) },
    { headers: { ...headers, origin: ORIGIN, cookie: `__Host-vpn_admin_login_csrf=${csrf}` } },
  ]) {
    assert.equal((await request(address, '/login', {
      method: 'POST', headers: { ...headers, origin: ORIGIN }, body, ...override,
    })).status, 403);
  }
  assert.equal(logins, 0);
  const login = await request(address, '/login', {
    method: 'POST', headers: { ...headers, origin: ORIGIN }, body,
  });
  assert.equal(login.status, 303);
  assert.equal(logins, 1);
  assertLocalCookie(login.headers['set-cookie'], 'vpn_admin_session_local');
  assertLocalCookie(login.headers['set-cookie'], 'vpn_admin_login_csrf_local');
  assert.equal(cookieValue(login.headers['set-cookie'], 'vpn_admin_session_local'), `vpn_admin_session_local=${SESSION}`);
  // The root is public in local mode too, and the public cookie name means nothing there.
  const home = await request(address, '/', { headers: { host: HOST, cookie: `__Host-vpn_admin_session=${SESSION}` } });
  assert.equal(home.status, 200);
  assert.equal(home.headers['set-cookie'], undefined);
  assert.match(home.body, /href="\/overview"/u);
  assert.equal((await request(address, '/overview', {
    headers: { host: HOST, cookie: `__Host-vpn_admin_session=${SESSION}` },
  })).status, 303);
  assert.equal(sessions, 0);
});

test('local dashboard and create or rotate responses share the local origin without changing controller data', async (t) => {
  const calls = [];
  const snapshot = {
    revision: 7, csrf: CSRF, users: [],
    gateway: { vpnPublicHostname: 'vpn.example.com', adminPublicHostname: 'admin.example.com',
      subscriptionPublicBaseUrl: 'https://old-subscriptions.example.com' },
  };
  const tokens = { create: 'A'.repeat(43), token: 'B'.repeat(43), credentials: 'C'.repeat(43) };
  const credential = (operation) => async (...args) => {
    if (args[1] !== CSRF) throw new ControlError('FORBIDDEN', 403);
    calls.push([operation, ...args]);
    return { rawToken: tokens[operation], vlessLink: 'vless://canonical-vpn',
      subscriptionUrl: `https://admin.example.com/s/${tokens[operation]}` };
  };
  const service = createAdminServer({
    host: '127.0.0.1', port: 0, publicHostname: 'admin.example.com', localHttpOrigin: ORIGIN,
    control: {
      checkSession: async (value) => { assert.equal(value, SESSION); },
      snapshot: async () => snapshot,
      createUser: credential('create'), rotateUserToken: credential('token'),
      rotateUserCredentials: credential('credentials'),
    },
  });
  const address = await service.listen();
  t.after(() => service.close());
  const headers = { host: HOST, cookie: `vpn_admin_session_local=${SESSION}`, origin: ORIGIN,
    'content-type': 'application/x-www-form-urlencoded' };
  const dashboard = await request(address, '/overview', { headers });
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.includes(ORIGIN));
  assert.doesNotMatch(dashboard.body, /https:\/\/(?:admin|old-subscriptions)\.example\.com/u);
  const fields = { csrf: CSRF, expectedRevision: '7', operationId: OPERATION_ID };
  for (const [route, operation, extra, status, subject] of [
    ['/users', 'create', { displayName: 'Alice' }, 201, 'Alice'],
    ['/users/alice/rotate-token', 'token', {}, 200, 'alice'],
    ['/users/alice/rotate-credentials', 'credentials', {}, 200, 'alice'],
  ]) {
    const options = { method: 'POST', headers, body: encoded({ ...fields, ...extra }) };
    const before = calls.length;
    assert.equal((await request(address, route, { ...options, headers: { ...headers, origin: 'http://localhost:18081' } })).status, 403);
    assert.equal((await request(address, route, { ...options, headers: { ...headers, host: '127.0.0.1:18082' } })).status, 403);
    assert.equal((await request(address, route, { ...options, body: encoded({ ...fields, ...extra, csrf: 'wrong' }) })).status, 303);
    assert.equal(calls.length, before);
    const result = await request(address, route, options);
    assert.equal(result.status, status);
    assert.ok(result.body.includes(`${ORIGIN}/s/${tokens[operation]}`));
    assert.ok(result.body.includes('vless://canonical-vpn'));
    assert.doesNotMatch(result.body, /https:\/\/admin\.example\.com/u);
    assert.deepEqual(calls.at(-1), [operation, SESSION, CSRF, 7, subject, OPERATION_ID]);
  }
  assert.equal(snapshot.gateway.subscriptionPublicBaseUrl, 'https://old-subscriptions.example.com');
});
