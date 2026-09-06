import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { probeSocksConnect } from '../../src/runtime/health-probe.js';

class FakeSocket extends EventEmitter {
  constructor(replyStatus, { authStatus = 0, method = 2 } = {}) {
    super();
    this.replyStatus = replyStatus;
    this.authStatus = authStatus;
    this.method = method;
    this.writes = [];
    queueMicrotask(() => this.emit('connect'));
  }

  write(chunk) {
    this.writes.push(Buffer.from(chunk));
    if (this.writes.length === 1) {
      queueMicrotask(() => this.emit('data', Buffer.from([5, this.method])));
    } else if (this.writes.length === 2) {
      queueMicrotask(() => this.emit('data', Buffer.from([1, this.authStatus])));
    } else if (this.authStatus === 0) {
      queueMicrotask(() => this.emit('data', Buffer.from([
        5, this.replyStatus, 0, 1, 127, 0, 0, 1, 0, 80,
      ])));
    }
  }

  destroy() {
    queueMicrotask(() => this.emit('close'));
  }
}

test('health probe completes a SOCKS5 connect handshake', async () => {
  const socket = new FakeSocket(0);
  const username = 'vpn-health';
  const password = 'health-password';
  await assert.doesNotReject(probeSocksConnect({
    proxyPort: 19080,
    username,
    password,
    targetHost: 'example.com',
    targetPort: 443,
    timeoutMs: 500,
    connect: () => socket,
  }));
  assert.deepEqual([...socket.writes[0]], [5, 1, 2]);
  assert.deepEqual(socket.writes[1], Buffer.concat([
    Buffer.from([1, Buffer.byteLength(username)]),
    Buffer.from(username),
    Buffer.from([Buffer.byteLength(password)]),
    Buffer.from(password),
  ]));
  assert.equal(socket.writes[2][3], 3);
});

test('health probe rejects a failed SOCKS connection', async () => {
  const socket = new FakeSocket(4);
  await assert.rejects(probeSocksConnect({
    proxyPort: 19080,
    username: 'vpn-health',
    password: 'health-password',
    targetHost: '2001:db8::1',
    targetPort: 443,
    timeoutMs: 500,
    connect: () => socket,
  }), /could not reach/);
  assert.equal(socket.writes[2][3], 4);
});

test('health probe requires RFC 1929 and stops when authentication fails', async () => {
  const noAuthentication = new FakeSocket(0, { method: 0 });
  await assert.rejects(probeSocksConnect({
    proxyPort: 19080,
    username: 'vpn-health',
    password: 'health-password',
    targetHost: 'example.com',
    targetPort: 443,
    timeoutMs: 500,
    connect: () => noAuthentication,
  }), /required SOCKS authentication method/u);
  assert.equal(noAuthentication.writes.length, 1);

  const rejected = new FakeSocket(0, { authStatus: 1 });
  await assert.rejects(probeSocksConnect({
    proxyPort: 19080,
    username: 'vpn-health',
    password: 'health-password',
    targetHost: 'example.com',
    targetPort: 443,
    timeoutMs: 500,
    connect: () => rejected,
  }), /rejected the health credentials/u);
  assert.equal(rejected.writes.length, 2);
});
