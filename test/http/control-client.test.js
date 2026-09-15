import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlError } from '../../src/control/socket/client-transport.js';
import { createControlClient } from '../../src/control/socket/client.js';

async function controller(t, responder) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-control-test-'));
  const socketPath = path.join(directory, 'c.sock');
  const server = net.createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      socket.end(`${JSON.stringify(responder(request))}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return socketPath;
}

test('control client sends one allowlisted NDJSON envelope and returns result', async (t) => {
  let observed;
  const socketPath = await controller(t, (request) => {
    observed = request;
    return { id: request.id, ok: true, result: { revision: 8 } };
  });
  const client = createControlClient({ socketPath });
  const result = await client.createUser('session', 'csrf', 7, 'Alice');
  assert.deepEqual(result, { revision: 8 });
  assert.equal(observed.op, 'user.create');
  assert.equal(observed.sessionId, 'session');
  assert.equal(observed.csrf, 'csrf');
  assert.equal(observed.expectedRevision, 7);
  assert.equal(observed.displayName, 'Alice');
  assert.match(observed.id, /^[0-9a-f-]{36}$/u);
});

test('control client forwards exit additions and removals with mutation authority', async (t) => {
  const observed = [];
  const socketPath = await controller(t, (request) => {
    observed.push(request);
    return { id: request.id, ok: true, result: { revision: request.expectedRevision + 1 } };
  });
  const client = createControlClient({ socketPath });
  assert.deepEqual(await client.addExit('session', 'csrf-add', 7, 'tailscale-device'), { revision: 8 });
  assert.deepEqual(await client.removeExit('session', 'csrf-remove', 8, '0123456789abcdef'), { revision: 9 });
  assert.deepEqual(await client.renameUser('session', 'csrf-rename', 9, 'user-one', 'Alice Phone'), { revision: 10 });
  assert.deepEqual(observed.map(({ id, ...request }) => request), [
    { op: 'exit.add', sessionId: 'session', csrf: 'csrf-add', expectedRevision: 7, deviceId: 'tailscale-device' },
    { op: 'exit.remove', sessionId: 'session', csrf: 'csrf-remove', expectedRevision: 8, exitId: '0123456789abcdef' },
    { op: 'user.rename', sessionId: 'session', csrf: 'csrf-rename', expectedRevision: 9, userId: 'user-one', displayName: 'Alice Phone' },
  ]);
});

test('control client forwards account and password operations without replay ids', async (t) => {
  const observed = [];
  const socketPath = await controller(t, (request) => {
    observed.push(request);
    return { id: request.id, ok: true, result: {} };
  });
  const client = createControlClient({ socketPath });
  await client.resetUserPassword('session', 'csrf-reset', 3, 'user-one');
  await client.accountLogin('Alice', 'portal-password');
  await client.accountCheck('account-session');
  await client.accountLogout('account-session', 'csrf-a');
  await client.accountSnapshot('account-session');
  await client.accountExport('account-session', 'clash');
  await client.accountRotateToken('account-session', 'csrf-b');
  await client.accountChangePassword('account-session', 'csrf-c', 'old-password', 'new-password');
  assert.deepEqual(observed.map(({ id, ...request }) => request), [
    { op: 'user.resetPassword', sessionId: 'session', csrf: 'csrf-reset', expectedRevision: 3, userId: 'user-one' },
    { op: 'account.login', displayName: 'Alice', password: 'portal-password' },
    { op: 'account.check', sessionId: 'account-session' },
    { op: 'account.logout', sessionId: 'account-session', csrf: 'csrf-a' },
    { op: 'account.snapshot', sessionId: 'account-session' },
    { op: 'account.export', sessionId: 'account-session', format: 'clash' },
    { op: 'account.rotateToken', sessionId: 'account-session', csrf: 'csrf-b' },
    { op: 'account.changePassword', sessionId: 'account-session', csrf: 'csrf-c', currentPassword: 'old-password', newPassword: 'new-password' },
  ]);
  assert.ok(observed.every((request) => /^[0-9a-f-]{36}$/u.test(request.id)));
  assert.equal(new Set(observed.map((request) => request.id)).size, observed.length);
});

test('control client rejects unknown operations and genericizes controller errors', async (t) => {
  const socketPath = await controller(t, (request) => ({
    id: request.id,
    ok: false,
    error: { code: 'CONFLICT', message: 'sensitive internal detail', status: 409 },
  }));
  const client = createControlClient({ socketPath });
  await assert.rejects(client.request('shell.exec', {}), TypeError);
  await assert.rejects(client.snapshot('session'), (error) => {
    assert.ok(error instanceof ControlError);
    assert.equal(error.code, 'CONFLICT');
    assert.equal(error.status, 409);
    assert.doesNotMatch(error.message, /sensitive/u);
    return true;
  });
});

test('control client rejects a response with the wrong correlation id', async (t) => {
  const socketPath = await controller(t, () => ({ id: 'wrong', ok: true, result: {} }));
  const client = createControlClient({ socketPath });
  await assert.rejects(client.health(), ControlError);
});

test('credential delivery retries one transport failure with the same operation id', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-control-retry-'));
  const socketPath = path.join(directory, 'c.sock');
  const observed = [];
  const server = net.createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const envelope = JSON.parse(input.slice(0, newline));
      observed.push(envelope);
      if (observed.length === 1) socket.destroy();
      else socket.end(`${JSON.stringify({ id: envelope.id, ok: true, result: { rawToken: 'replayed' } })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const operationId = '33333333-3333-4333-8333-333333333333';
  const clock = [0, 0, 60];
  const attemptTimeouts = [];
  const client = createControlClient({
    socketPath,
    timeoutMs: 100,
    now: () => clock.shift() ?? 60,
    connect: (options) => {
      const socket = net.createConnection(options);
      const setTimeout = socket.setTimeout.bind(socket);
      socket.setTimeout = (milliseconds, ...args) => {
        attemptTimeouts.push(milliseconds);
        return setTimeout(milliseconds, ...args);
      };
      return socket;
    },
  });
  assert.deepEqual(
    await client.createUser('session', 'csrf', 1, 'Alice', operationId),
    { rawToken: 'replayed' },
  );
  assert.equal(observed.length, 2);
  assert.equal(observed[0].id, operationId);
  assert.deepEqual(observed[1], observed[0]);
  assert.deepEqual(attemptTimeouts, [100, 40]);
});
