import assert from 'node:assert/strict';
import { chmod, mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createControlClient } from '../../src/control-client.js';
import { createControlSocketService } from '../../src/controller-server.js';

async function rawRequest(socketPath, bytes, { waitForEnd = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let received = Buffer.alloc(0);
    socket.once('connect', () => {
      if (bytes !== null) socket.write(bytes);
    });
    socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
    socket.once('error', reject);
    socket.once('end', () => resolve(received.toString('utf8')));
    if (!waitForEnd) resolve({ socket, received: () => received.toString('utf8') });
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('control socket interoperates with the client and survives malformed peers', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-control-'));
  const socketPath = path.join(directory, 'controller.sock');
  const calls = [];
  const service = createControlSocketService({
    controller: {
      async dispatch(request) {
        calls.push(request.op);
        if (request.op === 'auth.login') return { sessionId: 's'.repeat(43), csrf: 'c'.repeat(43) };
        if (request.op === 'health.status') return { status: 'ok', revision: 7 };
        throw Object.assign(new Error('sensitive internal detail'), { code: 'DENIED', status: 403 });
      },
    },
    socketPath,
    socketUid: null,
    socketGid: null,
    timeoutMs: 150,
    maxRequestBytes: 512,
  });
  await service.listen();
  t.after(() => service.close());

  const client = createControlClient({ socketPath, timeoutMs: 1_000 });
  assert.deepEqual(await client.health(), { status: 'ok', revision: 7 });

  const malformed = JSON.parse((await rawRequest(socketPath, '{not-json}\n')).trim());
  assert.deepEqual(malformed, {
    id: null,
    ok: false,
    error: { code: 'INVALID', message: 'Controller request failed', status: 400 },
  });

  const duplicate = JSON.parse((await rawRequest(
    socketPath,
    '{"id":"one","op":"health.status"}\n{"id":"two","op":"health.status"}\n',
  )).trim());
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'INVALID');

  const oversized = JSON.parse((await rawRequest(socketPath, `${'x'.repeat(513)}\n`)).trim());
  assert.equal(oversized.error.code, 'REQUEST_TOO_LARGE');

  const denied = JSON.parse((await rawRequest(
    socketPath,
    '{"id":"safe-id","op":"anything"}\n',
  )).trim());
  assert.deepEqual(denied, {
    id: 'safe-id',
    ok: false,
    error: { code: 'DENIED', message: 'Controller request failed', status: 403 },
  });
  assert.equal(JSON.stringify(denied).includes('sensitive'), false);

  assert.deepEqual(await client.health(), { status: 'ok', revision: 7 });
  assert.ok(calls.includes('health.status'));
});

test('idle control peers receive a bounded timeout response', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-control-timeout-'));
  const socketPath = path.join(directory, 'controller.sock');
  const service = createControlSocketService({
    controller: { dispatch: async () => ({}) },
    socketPath,
    socketUid: null,
    socketGid: null,
    timeoutMs: 100,
  });
  await service.listen();
  t.after(() => service.close());
  const response = JSON.parse((await rawRequest(socketPath, null)).trim());
  assert.equal(response.error.code, 'TIMEOUT');
  assert.equal(response.error.status, 408);
});

test('control socket rejects a group-writable parent directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-control-unsafe-'));
  await chmod(directory, 0o770);
  const service = createControlSocketService({
    controller: { dispatch: async () => ({}) },
    socketPath: path.join(directory, 'controller.sock'),
    socketUid: null,
    socketGid: null,
  });
  await assert.rejects(service.listen(), /socket directory is unsafe/u);
});

test('a second controller cannot unlink or replace a live controller socket', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-control-exclusive-'));
  const socketPath = path.join(directory, 'controller.sock');
  const first = createControlSocketService({
    controller: { dispatch: async () => ({ status: 'ok', revision: 11 }) },
    socketPath,
    socketUid: null,
    socketGid: null,
  });
  const second = createControlSocketService({
    controller: { dispatch: async () => ({ status: 'wrong', revision: 12 }) },
    socketPath,
    socketUid: null,
    socketGid: null,
  });
  await first.listen();
  t.after(() => first.close());
  await assert.rejects(second.listen(), /socket path already exists/u);
  const client = createControlClient({ socketPath, timeoutMs: 1_000 });
  assert.deepEqual(await client.health(), { status: 'ok', revision: 11 });
});

test('graceful close lets an accepted one-time credential response finish', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-control-drain-'));
  const socketPath = path.join(directory, 'controller.sock');
  const started = deferred();
  const release = deferred();
  const service = createControlSocketService({
    controller: {
      async dispatch() {
        started.resolve();
        await release.promise;
        return { rawToken: 'one-time-token' };
      },
    },
    socketPath,
    socketUid: null,
    socketGid: null,
  });
  await service.listen();
  const response = rawRequest(socketPath, '{"id":"create-1","op":"user.create"}\n');
  await started.promise;
  const closing = service.close();
  release.resolve();
  const result = JSON.parse((await response).trim());
  assert.equal(result.ok, true);
  assert.equal(result.result.rawToken, 'one-time-token');
  await closing;
});
