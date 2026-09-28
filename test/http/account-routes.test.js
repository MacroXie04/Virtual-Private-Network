import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin/application.js';
import { FixedWindowRateLimiter } from '../../src/http/shared/rate-limit.js';
import { ControlError } from '../../src/control/socket/client-transport.js';
import { renderAccountLoginPage } from '../../src/http/account/pages.js';
import { renderAccountPage } from '../../src/http/account/portal-page.js';
import { request, encoded } from '../helpers/admin-http.js';

const SESSION = 'portal-session-value-long-enough';
const SNAPSHOT = {
  csrf: 'account-csrf',
  ready: true,
  user: { id: 'alice', displayName: 'Alice <b>', createdAt: '2026-09-04T00:00:00.000Z' },
  usage: { uplinkBytes: 2048, downlinkBytes: 4_500_000, updatedAt: '2026-09-05T10:00:00.000Z' },
  gateway: { vpnPublicHostname: 'vpn.example.com', publicPort: 443 },
  exits: [{ id: '0123456789abcdef', name: 'Seoul <x>' }],
  connections: [
    { name: 'Default', link: 'vless://uuid@vpn.example.com:443?type=ws#Default' },
    { name: 'Seoul <x>', link: 'vless://uuid2@vpn.example.com:443?type=ws#Seoul<script>' },
  ],
};

function portal(t, { localHttpOrigin = '', snapshot = SNAPSHOT, limiters = {}, control: overrides = {} } = {}) {
  const calls = [];
  const control = {
    accountCheck: async (sessionId) => {
      if (sessionId !== SESSION) throw new ControlError('UNAUTHORIZED', 401);
    },
    accountSnapshot: async (sessionId) => {
      calls.push(['accountSnapshot', sessionId]);
      return snapshot;
    },
    accountExport: async (sessionId, format) => {
      calls.push(['accountExport', sessionId, format]);
      return { format, body: `body-for-${format}\n` };
    },
    accountLogout: async (...args) => { calls.push(['accountLogout', ...args]); return {}; },
    accountRotateToken: async (sessionId, csrf) => {
      calls.push(['accountRotateToken', sessionId, csrf]);
      if (csrf !== 'account-csrf') throw new ControlError('FORBIDDEN', 403);
      return {
        user: { id: 'alice', displayName: 'Alice' }, rawToken: 'rotated-token-value',
        vlessLink: 'vless://uuid@vpn.example.com:443?type=ws#Alice',
        subscriptionUrl: 'https://admin.example.com/s/rotated-token-value', revision: 3, csrf: 'next-csrf',
      };
    },
    accountChangePassword: async (sessionId, csrf, currentPassword, newPassword) => {
      calls.push(['accountChangePassword', sessionId, csrf, currentPassword, newPassword]);
      if (currentPassword !== 'current-password-value') throw new ControlError('PASSWORD_MISMATCH', 400);
      return { csrf: 'next-csrf' };
    },
    ...overrides,
  };
  const service = createAdminServer({ host: '127.0.0.1', port: 0, publicHostname: 'admin.test', localHttpOrigin, control, ...limiters });
  return service.listen().then((address) => {
    t.after(() => service.close());
    return { address, calls };
  });
}

const headers = { cookie: `__Host-vpn_account_session=${SESSION}` };
const postHeaders = { ...headers, origin: 'https://admin.test', 'content-type': 'application/x-www-form-urlencoded' };

test('the portal page shows the user\'s own connection details, usage and forms without scripts', async (t) => {
  const { address, calls } = await portal(t);
  const page = await request(address, '/account', { headers });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/u);
  assert.doesNotMatch(page.body, /<script/iu);
  assert.match(page.body, /Signed in as <strong>Alice &lt;b&gt;<\/strong>/u);
  assert.match(page.body, /<code>vpn\.example\.com:443<\/code>/u);
  assert.match(page.body, /Published exits<\/dt><dd>Seoul &lt;x&gt;<\/dd>/u);
  assert.match(page.body, /<dt>Seoul &lt;x&gt;<\/dt><dd><pre class="copy">vless:\/\/uuid2@vpn\.example\.com:443\?type=ws#Seoul&lt;script&gt;<\/pre>/u);
  assert.match(page.body, /2\.0 KB/u);
  assert.match(page.body, /4\.5 MB/u);
  assert.match(page.body, /2026-09-05/u);
  for (const format of ['sing-box', 'clash', 'links']) {
    assert.match(page.body, new RegExp(`href="/account/downloads/${format}"`, 'u'));
  }
  assert.match(page.body, /action="\/account\/rotate-token"[\s\S]*?name="csrf" value="account-csrf"/u);
  assert.match(page.body, /action="\/account\/password"[\s\S]*?name="newPassword"[^>]*minlength="12"/u);
  assert.match(page.body, /action="\/account\/logout"/u);
  assert.doesNotMatch(page.body, /href="\/users"|href="\/exit-nodes"|href="\/"|name="expectedRevision"|name="operationId"/u);
  assert.deepEqual(calls, [['accountSnapshot', SESSION]]);

  const head = await request(address, '/account', { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await request(address, '/account/unknown', { headers })).status, 404);
});

test('maintenance mode disables changes and tells the user why', async (t) => {
  const { address } = await portal(t, { snapshot: { ...SNAPSHOT, ready: false } });
  const page = await request(address, '/account', { headers });
  assert.match(page.body, /The gateway is in maintenance/u);
  assert.match(page.body, /<button type="submit" class="btn btn-secondary" disabled>Generate new subscription link/u);
  assert.match(page.body, /<button type="submit" class="btn btn-primary" disabled>Change password/u);
  assert.match(page.body, /Maintenance mode/u);
});

test('downloads carry fixed content types and filenames and never trust the socket for headers', async (t) => {
  const { address, calls } = await portal(t);
  for (const [format, type, filename] of [
    ['links', 'text/plain; charset=utf-8', 'vless-links.txt'],
    ['sing-box', 'application/json; charset=utf-8', 'sing-box.json'],
    ['clash', 'application/yaml; charset=utf-8', 'clash.yaml'],
  ]) {
    const get = await request(address, `/account/downloads/${format}`, { headers });
    assert.equal(get.status, 200);
    assert.equal(get.headers['content-type'], type);
    assert.equal(get.headers['content-disposition'], `attachment; filename="${filename}"`);
    assert.equal(get.body, `body-for-${format}\n`);
    const head = await request(address, `/account/downloads/${format}`, { method: 'HEAD', headers });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(Buffer.byteLength(get.body)));
  }
  assert.equal((await request(address, '/account/downloads/mixed', { headers })).status, 404);
  assert.equal(calls.filter((call) => call[0] === 'accountExport').length, 6);

  const hostile = await portal(t, {
    control: { accountExport: async (sessionId, format) => ({ format, body: 42, type: 'text/html', filename: 'x"\r\n' }) },
  });
  const broken = await request(hostile.address, '/account/downloads/links', { headers });
  assert.equal(broken.status, 500);
  const mismatch = await portal(t, { control: { accountExport: async () => ({ format: 'clash', body: 'x' }) } });
  assert.equal((await request(mismatch.address, '/account/downloads/links', { headers })).status, 500);
  let size = 256 * 1024;
  const bounded = await portal(t, { control: { accountExport: async (sessionId, format) => ({ format, body: 'é'.repeat(size / 2) }) } });
  assert.equal((await request(bounded.address, '/account/downloads/links', { headers })).status, 200);
  size += 2;
  assert.equal((await request(bounded.address, '/account/downloads/links', { headers })).status, 500);
});

test('token rotation renders the new link once using this site\'s origin', async (t) => {
  const { address, calls } = await portal(t);
  const post = (body) => request(address, '/account/rotate-token', { method: 'POST', headers: postHeaders, body });
  assert.equal((await post(encoded({ csrf: 'account-csrf', operationId: 'x' }))).status, 400);
  assert.equal((await post(`${encoded({ csrf: 'account-csrf' })}&csrf=again`)).status, 400);
  assert.equal(calls.filter((call) => call[0] === 'accountRotateToken').length, 0);
  const forbidden = await post(encoded({ csrf: 'stale' }));
  assert.equal(forbidden.status, 303);
  assert.equal(forbidden.headers.location, '/account/login');
  assert.match(forbidden.headers['set-cookie'][0], /^__Host-vpn_account_session=; /u);

  const rotated = await post(encoded({ csrf: 'account-csrf' }));
  assert.equal(rotated.status, 200);
  assert.equal(rotated.headers.location, undefined);
  assert.match(rotated.body, /New subscription link/u);
  assert.match(rotated.body, /<pre class="copy">https:\/\/admin\.test\/s\/rotated-token-value<\/pre>/u);
  assert.match(rotated.body, /https:\/\/admin\.test\/s\/rotated-token-value\/clash/u);
  assert.match(rotated.body, /<pre class="copy">rotated-token-value<\/pre>/u);
  assert.doesNotMatch(rotated.body, /https:\/\/admin\.example\.com/u);
  assert.deepEqual(calls.at(-2), ['accountRotateToken', SESSION, 'account-csrf']);

  // The controller already rotated the token: a failing follow-up snapshot must not hide it.
  const flaky = await portal(t, { control: { accountSnapshot: async () => { throw new ControlError('UNAVAILABLE', 503); } } });
  const shownAnyway = await request(flaky.address, '/account/rotate-token', { method: 'POST', headers: postHeaders, body: encoded({ csrf: 'account-csrf' }) });
  assert.equal(shownAnyway.status, 200);
  assert.match(shownAnyway.body, /<pre class="copy">rotated-token-value<\/pre>/u);
  assert.match(shownAnyway.body, /name="csrf" value="next-csrf"/u);

  const local = await portal(t, { localHttpOrigin: 'http://127.0.0.1:18081' });
  const localRotated = await request(local.address, '/account/rotate-token', {
    method: 'POST',
    headers: { host: '127.0.0.1:18081', origin: 'http://127.0.0.1:18081', cookie: `vpn_account_session_local=${SESSION}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: encoded({ csrf: 'account-csrf' }),
  });
  assert.equal(localRotated.status, 200);
  assert.match(localRotated.body, /http:\/\/127\.0\.0\.1:18081\/s\/rotated-token-value/u);
  assert.doesNotMatch(localRotated.body, /https:\/\/admin\.example\.com/u);
});

test('password changes are validated locally, flag the right field, and redirect after success', async (t) => {
  const { address, calls } = await portal(t);
  const post = (fields) => request(address, '/account/password', {
    method: 'POST', headers: postHeaders, body: encoded({ csrf: 'account-csrf', ...fields }),
  });
  const base = { currentPassword: 'current-password-value', newPassword: 'a-new-password-value', confirmPassword: 'a-new-password-value' };
  for (const [fields, flagged, message] of [
    [{ ...base, currentPassword: '' }, 'currentPassword', 'Enter your current password.'],
    [{ ...base, newPassword: 'short', confirmPassword: 'short' }, 'newPassword', 'Use at least 12 characters.'],
    [{ ...base, newPassword: '\u00e9'.repeat(600), confirmPassword: '\u00e9'.repeat(600) }, 'newPassword', 'Use at most 1024 bytes.'],
    [{ ...base, confirmPassword: 'a-different-value-here' }, 'confirmPassword', 'The new passwords do not match.'],
    [{ ...base, newPassword: 'current-password-value', confirmPassword: 'current-password-value' }, 'newPassword', 'Choose a different password.'],
  ]) {
    const response = await post(fields);
    assert.equal(response.status, 400);
    assert.match(response.body, new RegExp(`name="${flagged}"[^>]*aria-invalid="true"`, 'u'));
    assert.match(response.body, new RegExp(`id="${flagged}-error">${message.replace('.', '\\.')}`, 'u'));
    assert.equal((response.body.match(/aria-invalid="true"/gu) ?? []).length, 1);
    assert.doesNotMatch(response.body, /current-password-value|a-new-password-value/u);
  }
  assert.equal((await post({ ...base, extra: 'field' })).status, 400);
  assert.equal(calls.filter((call) => call[0] === 'accountChangePassword').length, 0);

  const mismatch = await post({ ...base, currentPassword: 'wrong-current-value' });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body, /name="currentPassword"[^>]*aria-invalid="true"/u);
  assert.match(mismatch.body, /Current password is incorrect\./u);
  assert.doesNotMatch(mismatch.body, /wrong-current-value/u);

  const changed = await post(base);
  assert.equal(changed.status, 303);
  assert.equal(changed.headers.location, '/account/password-changed');
  assert.deepEqual(calls.at(-1), ['accountChangePassword', SESSION, 'account-csrf', 'current-password-value', 'a-new-password-value']);
  const notice = await request(address, '/account/password-changed', { headers });
  assert.equal(notice.status, 200);
  assert.match(notice.body, /Password changed\. Other signed-in devices were signed out\./u);
});

test('sign-out is never budgeted and always clears the cookie while other mutations have a budget', async (t) => {
  const { address, calls } = await portal(t, {
    control: { accountLogout: async (...args) => { calls.push(['accountLogout', ...args]); throw new ControlError('UNAVAILABLE', 503); } },
    limiters: { accountMutationRateLimiter: new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000 }) },
  });
  const rotated = await request(address, '/account/rotate-token', { method: 'POST', headers: postHeaders, body: encoded({ csrf: 'account-csrf' }) });
  assert.equal(rotated.status, 200);
  const limited = await request(address, '/account/rotate-token', { method: 'POST', headers: postHeaders, body: encoded({ csrf: 'account-csrf' }) });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers['retry-after']);
  assert.equal(calls.filter((call) => call[0] === 'accountRotateToken').length, 1);
  // The budget is spent and the controller even fails: the session is still asked to end and the cookie goes.
  const logout = await request(address, '/account/logout', { method: 'POST', headers: postHeaders, body: encoded({ csrf: 'account-csrf' }) });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.location, '/account/login');
  assert.match(logout.headers['set-cookie'][0], /^__Host-vpn_account_session=; .*Max-Age=0$/u);
  assert.deepEqual(calls.filter((call) => call[0] === 'accountLogout'), [['accountLogout', SESSION, 'account-csrf']]);
  const fresh = await portal(t, {
    control: { accountLogout: async (...args) => { calls.push(['accountLogout', ...args]); throw new ControlError('UNAVAILABLE', 503); } },
  });
  const failing = await request(fresh.address, '/account/logout', { method: 'POST', headers: postHeaders, body: encoded({ csrf: 'account-csrf' }) });
  assert.equal(failing.status, 303);
  assert.match(failing.headers['set-cookie'][0], /Max-Age=0$/u);
  assert.deepEqual(calls.at(-1), ['accountLogout', SESSION, 'account-csrf']);
});

test('account pages escape hostile values and contain no executable content', () => {
  const login = renderAccountLoginPage({ csrf: 'csrf-token', displayName: '<img src=x onerror=alert(1)>', error: true, missingName: true });
  assert.doesNotMatch(login, /<script|<img\s/iu);
  assert.match(login, /value="&lt;img src=x onerror=alert\(1\)&gt;"/u);
  assert.match(login, /name="displayName"[^>]*aria-invalid="true"/u);
  assert.doesNotMatch(login, /href="\/"/u);
  const page = renderAccountPage({
    csrf: 'csrf<&"', ready: true, user: { displayName: '<script>alert(1)</script>' }, usage: null,
    gateway: { vpnPublicHostname: '<gateway>', publicPort: 443 }, exits: [],
    connections: [{ name: '<b>', link: 'vless://x#<script>' }],
  }, { publicOrigin: 'https://admin.test', credentials: { rawToken: '<token>', vlessLink: 'vless://y?<script>' } });
  assert.doesNotMatch(page, /<script(?:\s|>)/iu);
  assert.match(page, /name="csrf" value="csrf&lt;&amp;&quot;"/u);
  assert.match(page, /&lt;token&gt;/u);
  assert.match(page, /https:\/\/admin\.test\/s\/%3Ctoken%3E/u);
  assert.match(page, /No traffic recorded yet\./u);
  assert.doesNotMatch(page, /href="\/users"|href="\/exit-nodes"|href="\/"/u);
});
