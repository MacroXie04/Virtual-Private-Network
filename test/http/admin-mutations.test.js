import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin/application.js';
import { ControlError } from '../../src/control/socket/client-transport.js';

import { request, encoded, deferred, cookieValue } from '../helpers/admin-http.js';

test('published-exit routes preserve authentication, origin, exact forms, CSRF and revision checks', async (t) => {
  const calls = [];
  const sessionId = 'verified-session-long-enough';
  const mutation = (operation) => async (...args) => {
    if (args[1] !== 'valid-csrf') throw new ControlError('FORBIDDEN', 403);
    if (args[2] !== 7) throw new ControlError('STALE_REVISION', 409);
    calls.push([operation, ...args]);
  };
  const service = createAdminServer({
    host: '127.0.0.1', port: 0, publicHostname: 'admin.test',
    control: {
      checkSession: async (value) => {
        if (value !== sessionId) throw new ControlError('UNAUTHORIZED', 401);
      },
      snapshot: async () => ({ revision: 7, csrf: 'valid-csrf' }),
      addExit: mutation('add'),
      removeExit: mutation('remove'),
    },
  });
  const address = await service.listen();
  t.after(() => service.close());
  const headers = {
    cookie: `__Host-vpn_admin_session=${sessionId}`,
    origin: 'https://admin.test',
    'content-type': 'application/x-www-form-urlencoded',
  };
  for (const [route, fields, expectedCall, getStatus] of [
    ['/exit-nodes', { deviceId: 'tailscale-device' }, ['add', sessionId, 'valid-csrf', 7, 'tailscale-device'], 200],
    ['/exit-nodes/0123456789abcdef/remove', {}, ['remove', sessionId, 'valid-csrf', 7, '0123456789abcdef'], 404],
  ]) {
    const body = encoded({ csrf: 'valid-csrf', expectedRevision: '7', ...fields });
    const options = { method: 'POST', headers, body };
    assert.equal((await request(address, route, { ...options, headers: { ...headers, host: 'evil.test' } })).status, 403);
    assert.equal((await request(address, route, { ...options, headers: { ...headers, origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(address, route, { ...options, headers: { ...headers, cookie: '' } })).status, 303);
    assert.equal((await request(address, route, { headers })).status, getStatus);
    assert.equal((await request(address, route, { ...options, body: `${body}&csrf=duplicate` })).status, 400);
    assert.equal((await request(address, route, { ...options, body: `${body}&authKey=untrusted` })).status, 400);
    const invalidCsrf = await request(address, route, { ...options, body: encoded({ csrf: 'wrong', expectedRevision: '7', ...fields }) });
    assert.equal(invalidCsrf.status, 303);
    assert.equal(invalidCsrf.headers.location, '/login');
    assert.equal((await request(address, route, { ...options, body: encoded({ csrf: 'valid-csrf', expectedRevision: '6', ...fields }) })).status, 409);
    const result = await request(address, route, options);
    assert.equal(result.status, 303);
    assert.equal(result.headers.location, '/exit-nodes');
    assert.deepEqual(calls.at(-1), expectedCall);
  }
  for (const id of ['not-hex', '0123456789ABCDEFF', '0123456789abcdef0']) {
    assert.equal((await request(address, `/exit-nodes/${id}/remove`, {
      method: 'POST', headers, body: encoded({ csrf: 'valid-csrf', expectedRevision: '7' }),
    })).status, 404);
  }
  assert.equal(calls.length, 2);
});

test('portal password resets are exact forms that render the new password once', async (t) => {
  const calls = [];
  const sessionId = 'verified-session-long-enough';
  const service = createAdminServer({
    host: '127.0.0.1', port: 0, publicHostname: 'admin.test',
    control: {
      checkSession: async (value) => {
        if (value !== sessionId) throw new ControlError('UNAUTHORIZED', 401);
      },
      snapshot: async () => ({ revision: 7, csrf: 'valid-csrf', users: [{ id: 'user-one', displayName: 'Alice', status: 'active', hasPassword: true }] }),
      resetUserPassword: async (...args) => {
        calls.push(['resetUserPassword', ...args]);
        return { user: { id: 'user-one', displayName: 'Alice', hasPassword: true }, rawPassword: 'fresh-portal-password', revision: 8, csrf: 'next' };
      },
    },
  });
  const address = await service.listen();
  t.after(() => service.close());
  const headers = {
    cookie: `__Host-vpn_admin_session=${sessionId}`,
    origin: 'https://admin.test',
    'content-type': 'application/x-www-form-urlencoded',
  };
  const route = '/users/user-one/reset-password';
  assert.equal((await request(address, route, { headers })).status, 404);
  assert.equal((await request(address, route, {
    method: 'POST', headers, body: encoded({ csrf: 'valid-csrf', expectedRevision: '7', operationId: '11111111-1111-4111-8111-111111111111' }),
  })).status, 400);
  assert.equal(calls.length, 0);
  const reset = await request(address, route, { method: 'POST', headers, body: encoded({ csrf: 'valid-csrf', expectedRevision: '7' }) });
  assert.equal(reset.status, 200);
  assert.match(reset.body, /<h2 id="credentials-title">Portal password reset<\/h2>/u);
  assert.match(reset.body, /<pre class="copy">fresh-portal-password<\/pre>/u);
  assert.match(reset.body, /https:\/\/admin\.test\/account\/login/u);
  assert.deepEqual(calls, [['resetUserPassword', sessionId, 'valid-csrf', 7, 'user-one']]);
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

test('admin shutdown drains an accepted one-time credential response', async () => {
  const accepted = deferred();
  const release = deferred();
  const control = {
    checkSession: async () => ({}),
    snapshot: async () => ({ revision: 1, csrf: 'csrf', users: [] }),
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

test('empty required fields re-render the page with an inline message instead of a generic error', async (t) => {
  const calls = [];
  const control = {
    login: async (...args) => { calls.push(['login', ...args]); },
    checkSession: async () => ({}),
    snapshot: async () => ({ revision: 1, csrf: 'csrf', users: [{ id: 'user-one', displayName: 'Alice', status: 'active' }] }),
    createUser: async (...args) => { calls.push(['createUser', ...args]); },
    revokeUser: async (...args) => {
      calls.push(['revokeUser', ...args]);
      throw new ControlError('CONFIRMATION_MISMATCH', 400);
    },
  };
  const service = createAdminServer({ host: '127.0.0.1', port: 0, publicHostname: 'admin.test', control });
  const address = await service.listen();
  t.after(() => service.close());
  const loginPage = await request(address, '/login');
  const loginCsrf = cookieValue(loginPage.headers['set-cookie'], '__Host-vpn_admin_login_csrf');
  const login = await request(address, '/login', {
    method: 'POST',
    headers: { origin: 'https://admin.test', cookie: loginCsrf, 'content-type': 'application/x-www-form-urlencoded' },
    body: encoded({ csrf: loginCsrf.split('=')[1], secret: '' }),
  });
  assert.equal(login.status, 400);
  assert.match(login.headers['content-type'], /text\/html/u);
  assert.match(login.body, /name="secret"[^>]*aria-invalid="true"/u);
  const headers = {
    origin: 'https://admin.test', cookie: '__Host-vpn_admin_session=session-value-long-enough',
    'content-type': 'application/x-www-form-urlencoded',
  };
  const created = await request(address, '/users', {
    method: 'POST', headers,
    body: encoded({ csrf: 'csrf', expectedRevision: '1', displayName: '  ', operationId: '22222222-2222-4222-8222-222222222222' }),
  });
  assert.equal(created.status, 400);
  assert.match(created.headers['content-type'], /text\/html/u);
  assert.match(created.body, /name="displayName"[^>]*aria-invalid="true"/u);
  for (const confirmName of ['', 'Bob']) {
    const revoked = await request(address, '/users/user-one/revoke', {
      method: 'POST', headers, body: encoded({ csrf: 'csrf', expectedRevision: '1', confirmName }),
    });
    assert.equal(revoked.status, 400);
    assert.match(revoked.body, /<details class="danger" open>[\s\S]*name="confirmName"[^>]*aria-invalid="true"/u);
  }
  assert.deepEqual(calls, [['revokeUser', 'session-value-long-enough', 'csrf', 1, 'user-one', 'Bob']]);
});

test('renaming validates the name inline and returns to the users page on success', async (t) => {
  const calls = [];
  const control = {
    checkSession: async () => ({}),
    snapshot: async () => ({ revision: 1, csrf: 'csrf', users: [{ id: 'user-one', displayName: 'Alice', status: 'active' }] }),
    renameUser: async (...args) => {
      calls.push(args);
      if (args[4] === 'Taken') throw new ControlError('DISPLAY_NAME_CONFLICT', 409);
      if (args[4] === 'bad name') throw new ControlError('INVALID', 400);
    },
  };
  const service = createAdminServer({ host: '127.0.0.1', port: 0, publicHostname: 'admin.test', control });
  const address = await service.listen();
  t.after(() => service.close());
  const headers = {
    origin: 'https://admin.test', cookie: '__Host-vpn_admin_session=session-value-long-enough',
    'content-type': 'application/x-www-form-urlencoded',
  };
  const post = (displayName, extra = {}) => request(address, '/users/user-one/rename', {
    method: 'POST', headers, body: encoded({ csrf: 'csrf', expectedRevision: '1', displayName, ...extra }),
  });
  const renamed = await post('Alice Phone');
  assert.equal(renamed.status, 303);
  assert.equal(renamed.headers.location, '/users');
  assert.deepEqual(calls.at(-1), ['session-value-long-enough', 'csrf', 1, 'user-one', 'Alice Phone']);
  for (const [displayName, message] of [
    ['', 'Enter a display name.'],
    ['   ', 'Enter a display name.'],
    ['Taken', 'This name is already in use.'],
    ['bad name', 'Enter a valid display name'],
  ]) {
    const response = await post(displayName);
    assert.equal(response.status, 400);
    assert.match(response.headers['content-type'], /text\/html/u);
    assert.match(response.body, new RegExp(`<details class="rename" open>[\\s\\S]*?name="displayName"[^>]*aria-invalid="true"[\\s\\S]*?${message}`, 'u'));
  }
  assert.equal(calls.length, 3);
  assert.equal((await post('Alice', { operationId: '22222222-2222-4222-8222-222222222222' })).status, 400);
  assert.equal((await request(address, '/users/user-one/rename', { headers })).status, 404);
  assert.equal((await request(address, '/users/user-one/unknown', { method: 'POST', headers, body: encoded({ csrf: 'csrf', expectedRevision: '1' }) })).status, 404);
  assert.equal(calls.length, 3);
});
