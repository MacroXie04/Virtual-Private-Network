import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createAdminServer } from '../../src/admin-server.js';
import { ControlError } from '../../src/control-client.js';
import { FixedWindowRateLimiter } from '../../src/http-common.js';

function request(address, requestPath, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { host: 'admin.test', ...headers };
    if (body && !Object.hasOwn(requestHeaders, 'content-length')) {
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: requestPath,
      method,
      headers: requestHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function cookieValue(setCookie, name) {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  const row = values.find((value) => value?.startsWith(`${name}=`));
  return row?.split(';', 1)[0];
}

function encoded(values) {
  return new URLSearchParams(values).toString();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

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

test('admin server rejects oversized mutation bodies before controller dispatch', async (t) => {
  let called = false;
  const control = {
    health: async () => ({}),
    login: async () => { called = true; },
  };
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin.test',
    control,
  });
  const address = await service.listen();
  t.after(() => service.close());
  const response = await request(address, '/login', {
    method: 'POST',
    headers: {
      origin: 'https://admin.test',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `secret=${'x'.repeat(17 * 1024)}`,
  });
  assert.equal(response.status, 413);
  assert.equal(called, false);
});

test('admin server rejects duplicate and unexpected form fields before controller dispatch', async (t) => {
  let called = false;
  const control = {
    checkSession: async () => ({}),
    createUser: async () => { called = true; },
  };
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin.test',
    control,
  });
  const address = await service.listen();
  t.after(() => service.close());
  const headers = {
    origin: 'https://admin.test',
    cookie: '__Host-vpn_admin_session=session-value-long-enough',
    'content-type': 'application/x-www-form-urlencoded',
  };
  const duplicate = await request(address, '/users', {
    method: 'POST',
    headers,
    body: 'csrf=csrf&expectedRevision=1&displayName=Alice&displayName=Bob',
  });
  assert.equal(duplicate.status, 400);
  const unexpected = await request(address, '/users', {
    method: 'POST',
    headers,
    body: encoded({ csrf: 'csrf', expectedRevision: '1', displayName: 'Alice', admin: 'true' }),
  });
  assert.equal(unexpected.status, 400);
  assert.equal(called, false);
});

test('admin server enforces the authentication-failure rate limit with a real 429 response', async (t) => {
  let loginCalls = 0;
  const control = {
    login: async () => {
      loginCalls += 1;
      throw new ControlError('UNAUTHORIZED', 401);
    },
  };
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin.test',
    control,
    loginRateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 8,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  const loginPage = await request(address, '/login');
  const csrfCookie = cookieValue(loginPage.headers['set-cookie'], '__Host-vpn_admin_login_csrf');
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(loginPage.body)?.[1];
  assert.ok(csrfCookie);
  assert.ok(csrf);
  const options = {
    method: 'POST',
    headers: {
      origin: 'https://admin.test',
      cookie: csrfCookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '198.51.100.1',
    },
    body: encoded({ csrf, secret: 'incorrect-secret' }),
  };
  assert.equal((await request(address, '/login', options)).status, 401);
  const limited = await request(address, '/login', {
    ...options,
    headers: { ...options.headers, 'x-forwarded-for': '198.51.100.2' },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(limited.body, 'Too Many Requests\n');
  assert.equal(loginCalls, 1);
});

test('credentialless traffic cannot exhaust per-session administration limits', async (t) => {
  let snapshotCalls = 0;
  const control = {
    checkSession: async (sessionId) => {
      if (!['session-one-long-enough', 'session-two-long-enough'].includes(sessionId)) {
        throw new ControlError('UNAUTHORIZED', 401);
      }
      return {};
    },
    snapshot: async () => {
      snapshotCalls += 1;
      return {
        revision: 1,
        csrf: 'csrf',
        gateway: {
          vpnPublicHostname: 'vpn.example.com', publicPort: 443,
          subscriptionPublicBaseUrl: 'https://sub.example.com',
          adminPublicHostname: 'admin.test',
        },
        users: [],
        exitNodes: [],
      };
    },
  };
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin.test',
    control,
    rateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 2,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  assert.equal((await request(address, '/login')).status, 200);
  assert.equal((await request(address, '/', {
    headers: {
      cookie: '__Host-vpn_admin_session=session-one-long-enough',
      origin: 'https://hostile.test',
    },
  })).status, 403);

  for (let index = 0; index < 16; index += 1) {
    const fake = `fake-session-${String(index).padStart(3, '0')}-long-enough`;
    assert.equal((await request(address, '/', {
      headers: { cookie: `__Host-vpn_admin_session=${fake}` },
    })).status, 303);
  }

  const first = await request(address, '/', {
    headers: { cookie: '__Host-vpn_admin_session=session-one-long-enough' },
  });
  assert.equal(first.status, 200);
  assert.equal((await request(address, '/', {
    headers: { cookie: '__Host-vpn_admin_session=session-one-long-enough' },
  })).status, 429);
  assert.equal((await request(address, '/', {
    headers: { cookie: '__Host-vpn_admin_session=session-two-long-enough' },
  })).status, 200);
  assert.equal(snapshotCalls, 2);
});

test('anonymous aggregate throttling cannot block a verified administration session', async (t) => {
  const control = {
    checkSession: async (sessionId) => {
      if (sessionId !== 'verified-session-long-enough') throw new ControlError('UNAUTHORIZED', 401);
      return {};
    },
    snapshot: async () => ({
      revision: 1,
      csrf: 'csrf',
      gateway: {
        vpnPublicHostname: 'vpn.example.com', publicPort: 443,
        subscriptionPublicBaseUrl: 'https://sub.example.com',
        adminPublicHostname: 'admin.test',
      },
      users: [],
      exitNodes: [],
    }),
  };
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin.test',
    control,
    globalRateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 2,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  assert.equal((await request(address, '/login')).status, 200);
  assert.equal((await request(address, '/login')).status, 429);
  assert.equal((await request(address, '/', {
    headers: { cookie: '__Host-vpn_admin_session=verified-session-long-enough' },
  })).status, 200);
});

test('admin server rate-limits authenticated state-changing requests', async (t) => {
  let logoutCalls = 0;
  const control = {
    checkSession: async () => ({}),
    logout: async () => { logoutCalls += 1; },
  };
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin.test',
    control,
    mutationRateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 8,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());
  const options = {
    method: 'POST',
    headers: {
      origin: 'https://admin.test',
      cookie: '__Host-vpn_admin_session=session-value-long-enough',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: encoded({ csrf: 'csrf' }),
  };
  assert.equal((await request(address, '/logout', options)).status, 303);
  const limited = await request(address, '/logout', options);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(logoutCalls, 1);
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

test('admin shutdown drains an accepted one-time credential response', async () => {
  const accepted = deferred();
  const release = deferred();
  const control = {
    checkSession: async () => ({}),
    createUser: async () => {
      accepted.resolve();
      await release.promise;
      return { rawToken: 'one-time-token', vlessLink: 'vless://one-time' };
    },
  };
  const service = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    publicHostname: 'admin.test',
    control,
    shutdownTimeout: 1_000,
  });
  const address = await service.listen();
  const response = request(address, '/users', {
    method: 'POST',
    headers: {
      origin: 'https://admin.test',
      cookie: '__Host-vpn_admin_session=session-value-long-enough',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: encoded({
      csrf: 'csrf',
      expectedRevision: '1',
      displayName: 'Alice',
      operationId: '22222222-2222-4222-8222-222222222222',
    }),
  });
  await accepted.promise;
  const closing = service.close();
  release.resolve();
  const result = await response;
  assert.equal(result.status, 201);
  assert.match(result.body, /one-time-token/u);
  await closing;
});
