import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin-application.js';

import { request, cookieValue, encoded } from '../helpers/admin-http.js';

test('admin server enforces Host, Origin, login CSRF, session cookie, and mutation CSRF forwarding', async (t) => {
  const calls = [];
  const sessionId = `session_${'s'.repeat(32)}`;
  const control = {
    health: async () => ({ status: 'ok' }),
    checkSession: async (session) => calls.push(['checkSession', session]),
    login: async (secret) => {
      calls.push(['login', secret]);
      return { sessionId, csrf: 'controller-csrf', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    snapshot: async (session) => {
      calls.push(['snapshot', session]);
      return {
        revision: 7,
        csrf: 'controller-csrf',
        gateway: {
          vpnPublicHostname: 'vpn.example.com', publicPort: 443,
          subscriptionPublicBaseUrl: 'https://sub.example.com',
          adminPublicHostname: 'admin.test',
        },
        users: [{ id: 'alice', displayName: 'Alice', status: 'active' }],
        exitNodes: [{ deviceId: 'exit-one', name: 'Exit one' }],
      };
    },
    createUser: async (...args) => {
      calls.push(['createUser', ...args]);
      return { rawToken: 'raw-once', vlessLink: 'vless://once', subscriptionUrl: 'https://sub.test/s/raw-once' };
    },
    exportUser: async (...args) => {
      calls.push(['exportUser', ...args]);
      return { vlessLink: 'vless://exported' };
    },
    logout: async (...args) => calls.push(['logout', ...args]),
    setUserStatus: async (...args) => calls.push(['setUserStatus', ...args]),
    revokeUser: async (...args) => calls.push(['revokeUser', ...args]),
    rotateUserToken: async (...args) => ({ rawToken: 'rotated', vlessLink: 'vless://rotated' }),
    rotateUserCredentials: async (...args) => ({ rawToken: 'rotated-all', vlessLink: 'vless://rotated-all' }),
    selectExit: async (...args) => calls.push(['selectExit', ...args]),
    setPublicBase: async (...args) => calls.push(['setPublicBase', ...args]),
  };
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin.test',
    control,
  });
  const address = await service.listen();
  t.after(() => service.close());

  assert.equal((await request(address, '/login', { headers: { host: 'evil.test' } })).status, 403);
  assert.equal((await request(address, '/healthz')).status, 303);
  assert.equal(calls.length, 0);
  const loginPage = await request(address, '/login');
  assert.equal(loginPage.status, 200);
  const csrfCookie = cookieValue(loginPage.headers['set-cookie'], '__Host-vpn_admin_login_csrf');
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(loginPage.body)?.[1];
  assert.ok(csrfCookie);
  assert.ok(csrf);
  assert.match(loginPage.headers['set-cookie'][0], /HttpOnly/u);
  assert.match(loginPage.headers['set-cookie'][0], /SameSite=Strict/u);
  assert.match(loginPage.headers['set-cookie'][0], /; Secure/u);

  const loginBody = encoded({ csrf, secret: 'admin-secret' });
  const missingOrigin = await request(address, '/login', {
    method: 'POST',
    headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: loginBody,
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(calls.length, 0);

  const login = await request(address, '/login', {
    method: 'POST',
    headers: {
      origin: 'https://admin.test',
      cookie: csrfCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: loginBody,
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.location, '/');
  const sessionCookie = cookieValue(login.headers['set-cookie'], '__Host-vpn_admin_session');
  assert.ok(sessionCookie);
  const sessionSetCookie = login.headers['set-cookie'].find((value) => value.startsWith('__Host-vpn_admin_session='));
  assert.match(sessionSetCookie, /HttpOnly/u);
  assert.match(sessionSetCookie, /SameSite=Strict/u);
  assert.match(sessionSetCookie, /; Secure/u);
  assert.deepEqual(calls[0], ['login', 'admin-secret']);

  const dashboard = await request(address, '/', { headers: { cookie: sessionCookie } });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /Alice/u);
  assert.match(dashboard.headers['content-security-policy'], /frame-ancestors 'none'/u);
  assert.equal(dashboard.headers['strict-transport-security'], 'max-age=31536000');

  const operationId = '11111111-1111-4111-8111-111111111111';
  const createBody = encoded({
    csrf: 'controller-csrf',
    expectedRevision: '7',
    displayName: 'Bob',
    operationId,
  });
  const created = await request(address, '/users', {
    method: 'POST',
    headers: {
      origin: 'https://admin.test',
      cookie: sessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: createBody,
  });
  assert.equal(created.status, 201);
  assert.match(created.body, /raw-once/u);
  assert.deepEqual(calls.find((call) => call[0] === 'createUser'), [
    'createUser', sessionId, 'controller-csrf', 7, 'Bob', operationId,
  ]);

  const exportResponse = await request(address, '/users/alice/export', { headers: { cookie: sessionCookie } });
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.body, 'vless://exported\n');
  assert.doesNotMatch(exportResponse.body, /raw-once/u);
  assert.equal((await request(address, '/users/alice/status', { headers: { cookie: sessionCookie } })).status, 404);

  const emptyPublicBase = await request(address, '/public-base', {
    method: 'POST',
    headers: {
      origin: 'https://admin.test', cookie: sessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: encoded({ csrf: 'controller-csrf', expectedRevision: '7', url: '' }),
  });
  assert.equal(emptyPublicBase.status, 400);
  assert.equal(calls.some((call) => call[0] === 'setPublicBase'), false);
});
