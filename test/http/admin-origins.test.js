import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin-application.js';

import { request, cookieValue, encoded } from '../helpers/admin-http.js';

test('admin server requires one dedicated public hostname', () => {
  for (const publicHostname of ['127.0.0.1', 'localhost', 'admin.localhost', 'singlelabel', 'admin.test.']) {
    assert.throws(() => createAdminServer({
      host: '127.0.0.1',
      port: 8081,
      publicHostname,
      control: {},
    }), /dedicated DNS hostname/u);
  }
  assert.throws(() => createAdminServer({ host: '0.0.0.0', port: 8081, publicHostname: 'admin.test' }), /loopback/u);
});

test('admin server requires each request Origin authority to equal its Host', async (t) => {
  let loginCalls = 0;
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin-one.test',
    control: { login: async () => { loginCalls += 1; } },
  });
  const address = await service.listen();
  t.after(() => service.close());
  const loginPage = await request(address, '/login', { headers: { host: 'admin-one.test' } });
  const csrfCookie = cookieValue(loginPage.headers['set-cookie'], '__Host-vpn_admin_login_csrf');
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(loginPage.body)?.[1];
  const response = await request(address, '/login', {
    method: 'POST',
    headers: {
      host: 'admin-one.test',
      origin: 'https://admin-two.test',
      cookie: csrfCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: encoded({ csrf, secret: 'admin-secret' }),
  });
  assert.equal(response.status, 403);
  assert.equal(loginCalls, 0);
});

test('admin server trusts only explicit proxy-facing Host and Origin allowlists', async (t) => {
  let loginCalls = 0;
  const sessionId = `session_${'p'.repeat(32)}`;
  const control = {
    login: async () => {
      loginCalls += 1;
      return {
        sessionId,
        csrf: 'controller-csrf',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin.example.test',
    control,
  });
  const address = await service.listen();
  t.after(() => service.close());

  const forwardedHostOnly = await request(address, '/login', {
    headers: {
      host: '127.0.0.1:8081',
      'x-forwarded-host': 'admin.example.test',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(forwardedHostOnly.status, 403);

  const loginPage = await request(address, '/login', {
    headers: {
      host: 'admin.example.test',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'http',
    },
  });
  assert.equal(loginPage.status, 200);
  const csrfCookie = cookieValue(loginPage.headers['set-cookie'], '__Host-vpn_admin_login_csrf');
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(loginPage.body)?.[1];
  assert.ok(csrfCookie);
  assert.ok(csrf);
  const body = encoded({ csrf, secret: 'admin-secret' });

  const forwardedOriginOnly = await request(address, '/login', {
    method: 'POST',
    headers: {
      host: 'admin.example.test',
      origin: 'http://127.0.0.1:8081',
      'x-forwarded-host': 'admin.example.test',
      'x-forwarded-proto': 'https',
      cookie: csrfCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  assert.equal(forwardedOriginOnly.status, 403);
  assert.equal(loginCalls, 0);

  const accepted = await request(address, '/login', {
    method: 'POST',
    headers: {
      host: 'admin.example.test',
      origin: 'https://admin.example.test',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'http',
      cookie: csrfCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  assert.equal(accepted.status, 303);
  assert.equal(loginCalls, 1);
  const sessionCookie = accepted.headers['set-cookie'].find((value) => value.startsWith('__Host-vpn_admin_session='));
  assert.match(sessionCookie, /; Secure/u);
});
