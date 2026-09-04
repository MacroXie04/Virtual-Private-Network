import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlError, createControlClient } from '../../src/control-client.js';

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
