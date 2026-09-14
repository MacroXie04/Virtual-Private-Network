import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin/application.js';
import { FixedWindowRateLimiter } from '../../src/http/shared/rate-limit.js';
import { ControlError } from '../../src/control/socket/client-transport.js';
import { request, cookieValue, encoded } from '../helpers/admin-http.js';

const SESSION = 'portal-session-value-long-enough';
const ADMIN_SESSION = 'administrator-session-value-long';
const PASSWORD = 'abcde-fghij-kmnop-qrstu';
const forbidden = (name) => ({ take() { throw new Error(`account traffic spent the administrator ${name} bucket`); } });

function portal(t, { localHttpOrigin = '', limiters = {}, control: overrides = {} } = {}) {
  const calls = [];
  const control = {
    accountLogin: async (displayName, password) => {
      calls.push(['accountLogin', displayName, password]);
      if (displayName !== 'Alice' || password !== PASSWORD) throw new ControlError('UNAUTHORIZED', 401);
      return { sessionId: SESSION, csrf: 'account-csrf', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    accountCheck: async (sessionId) => {
      calls.push(['accountCheck', sessionId]);
      if (sessionId !== SESSION) throw new ControlError('UNAUTHORIZED', 401);
    },
    accountSnapshot: async () => ({ csrf: 'account-csrf', ready: true, user: { id: 'alice', displayName: 'Alice' }, connections: [] }),
    checkSession: async (sessionId) => {
      calls.push(['checkSession', sessionId]);
      if (sessionId !== ADMIN_SESSION) throw new ControlError('UNAUTHORIZED', 401);
    },
    snapshot: async () => ({ revision: 1, csrf: 'admin-csrf', ready: true, users: [], exitNodes: [] }),
    ...overrides,
  };
  const service = createAdminServer({
    host: '127.0.0.1', port: 0, publicHostname: 'admin.test', localHttpOrigin, control,
    loginRateLimiter: forbidden('login'), rateLimiter: forbidden('authenticated'), mutationRateLimiter: forbidden('mutation'),
    ...limiters,
  });
  return service.listen().then((address) => {
    t.after(() => service.close());
    return { address, calls };
  });
}

async function loginForm(address, headers = {}) {
  const page = await request(address, '/account/login', { headers });
  const csrfCookie = cookieValue(page.headers['set-cookie'], headers.host ? 'vpn_account_login_csrf_local' : '__Host-vpn_account_login_csrf');
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/u.exec(page.body)?.[1];
  return { page, csrfCookie, csrf };
}

test('account sign-in owns its cookies and never spends administrator limits or sessions', async (t) => {
  const { address, calls } = await portal(t);
  const { page, csrfCookie, csrf } = await loginForm(address);
  assert.equal(page.status, 200);
  assert.match(page.body, /method="post" action="\/account\/login"/u);
  assert.doesNotMatch(page.body, /<script/iu);
  assert.match(page.headers['set-cookie'][0], /^__Host-vpn_account_login_csrf=[A-Za-z0-9_-]{43}; Path=\/; SameSite=Strict; HttpOnly; Secure$/u);
  const headers = { origin: 'https://admin.test', cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' };
  const post = (body, extra = {}) => request(address, '/account/login', { method: 'POST', headers: { ...headers, ...extra }, body });
  const valid = encoded({ csrf, displayName: '  Alice ', password: PASSWORD });

  const { origin: _dropped, ...withoutOrigin } = headers;
  assert.equal((await request(address, '/account/login', { method: 'POST', headers: withoutOrigin, body: valid })).status, 403);
  assert.equal((await post(valid, { host: 'evil.test' })).status, 403);
  assert.equal((await post(encoded({ csrf: 'x'.repeat(43), displayName: 'Alice', password: PASSWORD }))).status, 403);
  assert.equal((await post(`${valid}&userId=alice`)).status, 400);
  const missingName = await post(encoded({ csrf, displayName: '', password: PASSWORD }));
  assert.equal(missingName.status, 400);
  assert.match(missingName.body, /name="displayName"[^>]*aria-invalid="true"/u);
  const missingPassword = await post(encoded({ csrf, displayName: 'Alice', password: '' }));
  assert.equal(missingPassword.status, 400);
  assert.match(missingPassword.body, /name="password"[^>]*aria-invalid="true"/u);
  const impossible = await post(encoded({ csrf, displayName: 'x'.repeat(70), password: PASSWORD }));
  assert.equal(impossible.status, 401);
  assert.match(impossible.body, /Sign-in failed/u);
  assert.equal(calls.length, 0, 'nothing above may reach the controller');

  const wrong = await post(encoded({ csrf, displayName: 'Alice', password: 'not-the-password' }));
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /Sign-in failed\. Check your display name and password\./u);
  assert.match(wrong.body, /value="Alice"/u);
  assert.ok(cookieValue(wrong.headers['set-cookie'], '__Host-vpn_account_login_csrf'));
  assert.deepEqual(calls.at(-1), ['accountLogin', 'Alice', 'not-the-password']);

  const login = await post(valid);
  assert.equal(login.status, 303);
  assert.equal(login.headers.location, '/account');
  assert.deepEqual(calls.at(-1), ['accountLogin', 'Alice', PASSWORD]);
  const sessionCookie = login.headers['set-cookie'].find((value) => value.startsWith('__Host-vpn_account_session='));
  assert.match(sessionCookie, /^__Host-vpn_account_session=portal-session-value-long-enough; Path=\/; SameSite=Strict; HttpOnly; Secure; Max-Age=\d+$/u);
  assert.match(login.headers['set-cookie'].find((value) => value.startsWith('__Host-vpn_account_login_csrf=')), /Max-Age=0/u);
  assert.ok(login.headers['set-cookie'].every((value) => !value.includes('vpn_admin')));

  const home = await request(address, '/account', { headers: { cookie: `__Host-vpn_account_session=${SESSION}` } });
  assert.equal(home.status, 200);
  assert.match(home.body, /Signed in as <strong>Alice<\/strong>/u);
  assert.deepEqual(calls.at(-1), ['accountCheck', SESSION]);
  assert.equal(calls.some((call) => call[0] === 'checkSession'), false);
});

test('the two realms ignore each other\'s cookies and only ever clear their own', async (t) => {
  const { address, calls } = await portal(t, { limiters: { rateLimiter: new FixedWindowRateLimiter({ limit: 100 }) } });
  const adminOnPortal = await request(address, '/account', { headers: { cookie: `__Host-vpn_admin_session=${ADMIN_SESSION}` } });
  assert.equal(adminOnPortal.status, 303);
  assert.equal(adminOnPortal.headers.location, '/account/login');
  // Nothing presented means nothing cleared: a cross-site link cannot sign anyone out.
  assert.equal(adminOnPortal.headers['set-cookie'], undefined);
  const portalOnAdmin = await request(address, '/users', { headers: { cookie: `__Host-vpn_account_session=${SESSION}` } });
  assert.equal(portalOnAdmin.status, 303);
  assert.equal(portalOnAdmin.headers.location, '/login');
  assert.equal(portalOnAdmin.headers['set-cookie'], undefined);
  assert.equal(calls.length, 0);

  for (const pathname of ['/account', '/account/downloads/links', '/account/password-changed', '/account/nope']) {
    const response = await request(address, pathname);
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/account/login');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal((await request(address, '/account?x=1')).status, 400);
  assert.equal((await request(address, '/account/login', { method: 'DELETE' })).status, 404);

  const expired = await request(address, '/account', { headers: { cookie: `__Host-vpn_account_session=${'z'.repeat(32)}` } });
  assert.equal(expired.status, 303);
  assert.equal(expired.headers.location, '/account/login');
  assert.match(expired.headers['set-cookie'][0], /^__Host-vpn_account_session=; /u);
  assert.ok(expired.headers['set-cookie'].every((value) => !value.includes('vpn_admin')));
  assert.deepEqual(calls.at(-1), ['accountCheck', 'z'.repeat(32)]);

  const both = { cookie: `__Host-vpn_admin_session=${ADMIN_SESSION}; __Host-vpn_account_session=${SESSION}` };
  assert.equal((await request(address, '/account', { headers: both })).status, 200);
  assert.deepEqual(calls.at(-1), ['accountCheck', SESSION]);
  assert.equal((await request(address, '/', { headers: both })).status, 200);
  assert.deepEqual(calls.at(-1), ['checkSession', ADMIN_SESSION]);
});

test('the stylesheet is served to portal sessions without spending the anonymous bucket', async (t) => {
  const { address } = await portal(t, { limiters: { globalRateLimiter: forbidden('global') } });
  const styles = await request(address, '/assets/admin.css', { headers: { cookie: `__Host-vpn_account_session=${SESSION}` } });
  assert.equal(styles.status, 200);
  assert.match(styles.headers['content-type'], /text\/css/u);
});

test('sign-in attempts are budgeted per normalized name and per source before any controller call', async (t) => {
  const { address, calls } = await portal(t, {
    limiters: {
      accountLoginRateLimiter: new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000 }),
      accountLoginSourceRateLimiter: new FixedWindowRateLimiter({ limit: 6, windowMs: 60_000 }),
    },
  });
  const attempt = async (displayName) => {
    const { csrfCookie, csrf } = await loginForm(address);
    return request(address, '/account/login', {
      method: 'POST',
      headers: { origin: 'https://admin.test', cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: encoded({ csrf, displayName, password: 'wrong-password-value' }),
    });
  };
  assert.equal((await attempt('José')).status, 401);
  const variant = await attempt(' josé ');
  assert.equal(variant.status, 429);
  assert.ok(variant.headers['retry-after']);
  assert.equal((await attempt('JOSÉ')).status, 429);
  assert.equal((await attempt('Bob')).status, 401);
  assert.equal(calls.filter((call) => call[0] === 'accountLogin').length, 2);
  // Source budget: two more attempts exhaust it; the next is refused before the form is read.
  assert.equal((await attempt('Carol')).status, 401);
  assert.equal((await attempt('Dave')).status, 401);
  assert.equal((await attempt('Erin')).status, 429);
  assert.equal(calls.filter((call) => call[0] === 'accountLogin').length, 4);
});

test('local HTTP mode uses non-Secure account cookies with distinct names', async (t) => {
  const localHttpOrigin = 'http://127.0.0.1:18081';
  const { address } = await portal(t, { localHttpOrigin });
  const headers = { host: '127.0.0.1:18081' };
  const { page, csrfCookie, csrf } = await loginForm(address, headers);
  assert.equal(page.status, 200);
  assert.match(page.headers['set-cookie'][0], /^vpn_account_login_csrf_local=[A-Za-z0-9_-]{43}; Path=\/; SameSite=Strict; HttpOnly$/u);
  const login = await request(address, '/account/login', {
    method: 'POST',
    headers: { ...headers, origin: localHttpOrigin, cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: encoded({ csrf, displayName: 'Alice', password: PASSWORD }),
  });
  assert.equal(login.status, 303);
  const session = login.headers['set-cookie'].find((value) => value.startsWith('vpn_account_session_local='));
  assert.match(session, /; HttpOnly; Max-Age=\d+$/u);
  assert.doesNotMatch(session, /Secure/u);
  assert.equal((await request(address, '/account', { headers: { ...headers, cookie: `vpn_account_session_local=${SESSION}` } })).status, 200);
  // The public cookie name means nothing in local mode.
  const wrongRealm = await request(address, '/account', { headers: { ...headers, cookie: `__Host-vpn_account_session=${SESSION}` } });
  assert.equal(wrongRealm.status, 303);
  assert.equal(wrongRealm.headers.location, '/account/login');
});
