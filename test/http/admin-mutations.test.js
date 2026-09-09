import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminServer } from '../../src/http/admin/application.js';
import { ControlError } from '../../src/control/socket/client-transport.js';

import { request, encoded, deferred } from '../helpers/admin-http.js';

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
  for (const [route, fields, expectedCall] of [
    ['/exit-nodes', { deviceId: 'tailscale-device' }, ['add', sessionId, 'valid-csrf', 7, 'tailscale-device']],
    ['/exit-nodes/0123456789abcdef/remove', {}, ['remove', sessionId, 'valid-csrf', 7, '0123456789abcdef']],
  ]) {
    const body = encoded({ csrf: 'valid-csrf', expectedRevision: '7', ...fields });
    const options = { method: 'POST', headers, body };
    assert.equal((await request(address, route, { ...options, headers: { ...headers, host: 'evil.test' } })).status, 403);
    assert.equal((await request(address, route, { ...options, headers: { ...headers, origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(address, route, { ...options, headers: { ...headers, cookie: '' } })).status, 303);
    assert.equal((await request(address, route, { headers })).status, 404);
    assert.equal((await request(address, route, { ...options, body: `${body}&csrf=duplicate` })).status, 400);
    assert.equal((await request(address, route, { ...options, body: `${body}&authKey=untrusted` })).status, 400);
    const invalidCsrf = await request(address, route, { ...options, body: encoded({ csrf: 'wrong', expectedRevision: '7', ...fields }) });
    assert.equal(invalidCsrf.status, 303);
    assert.equal(invalidCsrf.headers.location, '/login');
    assert.equal((await request(address, route, { ...options, body: encoded({ csrf: 'valid-csrf', expectedRevision: '6', ...fields }) })).status, 409);
    const result = await request(address, route, options);
    assert.equal(result.status, 303);
    assert.equal(result.headers.location, '/');
    assert.deepEqual(calls.at(-1), expectedCall);
  }
  for (const id of ['not-hex', '0123456789ABCDEFF', '0123456789abcdef0']) {
    assert.equal((await request(address, `/exit-nodes/${id}/remove`, {
      method: 'POST', headers, body: encoded({ csrf: 'valid-csrf', expectedRevision: '7' }),
    })).status, 404);
  }
  assert.equal(calls.length, 2);
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
