import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { probeWebSocketUpgrade } from '../../src/websocket-probe.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class FakeSocket extends EventEmitter {
  setTimeout() {}
  destroy() {}
  write(bytes) {
    this.request = String(bytes);
    const key = /Sec-WebSocket-Key: ([^\r]+)/u.exec(this.request)[1];
    const accept = createHash('sha1').update(`${key}${GUID}`, 'ascii').digest('base64');
    queueMicrotask(() => this.emit('data', Buffer.from(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )));
  }
}

test('WebSocket probe requires a valid RFC 6455 upgrade at the canonical path and Host', async () => {
  const socket = new FakeSocket();
  queueMicrotask(() => socket.emit('connect'));
  await probeWebSocketUpgrade({
    connectPort: 8443,
    authority: 'vpn.example.com',
    path: `/${'A'.repeat(43)}`,
    connect: () => socket,
    randomBytesImpl: () => Buffer.alloc(16, 7),
  });
  assert.match(socket.request, /^GET \/A{43} HTTP\/1\.1\r\nHost: vpn\.example\.com\r\n/u);
});

test('WebSocket probe rejects an incorrect path input and a non-upgrade response', async () => {
  assert.throws(() => probeWebSocketUpgrade({
    connectPort: 8443,
    authority: 'vpn.example.com',
    path: '/short',
  }), /URL-safe segment|length/u);
  const socket = new FakeSocket();
  socket.write = () => queueMicrotask(() => socket.emit('data', Buffer.from(
    'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n',
  )));
  queueMicrotask(() => socket.emit('connect'));
  await assert.rejects(probeWebSocketUpgrade({
    connectPort: 8443,
    authority: 'vpn.example.com',
    path: `/${'A'.repeat(43)}`,
    connect: () => socket,
    randomBytesImpl: () => Buffer.alloc(16, 7),
  }), /did not become ready/u);
});
