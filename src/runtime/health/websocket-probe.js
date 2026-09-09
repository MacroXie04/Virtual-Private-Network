import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { validatePort } from '../../core/validation/values.js';
import { validatePublicDnsHostname, validateWebSocketPath } from '../../core/validation/ingress.js';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_RESPONSE_BYTES = 16 * 1024;

function singleHeader(lines, name) {
  const matches = [];
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error('invalid WebSocket response');
    if (line.slice(0, separator).trim().toLowerCase() === name) {
      matches.push(line.slice(separator + 1).trim());
    }
  }
  if (matches.length !== 1) throw new Error('invalid WebSocket response');
  return matches[0];
}

/** Verify that the private sing-box origin accepts only the configured WS route. */
export function probeWebSocketUpgrade({
  connectHost = '127.0.0.1',
  connectPort,
  authority,
  path,
  timeoutMs = 3000,
  connect = net.createConnection,
  randomBytesImpl = randomBytes,
} = {}) {
  if (connectHost !== '127.0.0.1') throw new TypeError('WebSocket probe must use IPv4 loopback');
  const port = validatePort(connectPort, 'websocket.connectPort');
  const host = validatePublicDnsHostname(authority, 'websocket.authority');
  const websocketPath = validateWebSocketPath(path, 'websocket.path');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('WebSocket probe timeout is invalid');
  }
  const nonce = randomBytesImpl(16);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 16) {
    throw new Error('WebSocket probe nonce generation failed');
  }
  const key = nonce.toString('base64');
  const expectedAccept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`, 'ascii').digest('base64');

  return new Promise((resolve, reject) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const socket = connect({ host: connectHost, port });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(new Error('local VLESS WebSocket origin did not become ready'));
      else resolve(true);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write([
        `GET ${websocketPath} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      if (received.length + chunk.length > MAX_RESPONSE_BYTES) {
        finish(new Error('oversized response'));
        return;
      }
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(received.subarray(0, boundary));
        const lines = text.split('\r\n');
        if (lines.shift() !== 'HTTP/1.1 101 Switching Protocols') throw new Error('unexpected status');
        if (singleHeader(lines, 'upgrade').toLowerCase() !== 'websocket') throw new Error('invalid upgrade');
        if (!singleHeader(lines, 'connection').split(',').map((item) => item.trim().toLowerCase()).includes('upgrade')) {
          throw new Error('invalid connection');
        }
        if (singleHeader(lines, 'sec-websocket-accept') !== expectedAccept) throw new Error('invalid accept');
        finish();
      } catch (error) {
        finish(error);
      }
    });
    socket.once('timeout', () => finish(new Error('timeout')));
    socket.once('error', (error) => finish(error));
    socket.once('end', () => finish(new Error('closed')));
  });
}
