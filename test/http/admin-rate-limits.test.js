import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin-application.js';
import { ControlError } from '../../src/control/control-client.js';
import { FixedWindowRateLimiter } from '../../src/http/rate-limit.js';

import { request, cookieValue, encoded } from '../helpers/admin-http.js';

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
