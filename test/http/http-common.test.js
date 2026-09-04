import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import {
  FixedWindowRateLimiter,
  createHttpService,
  parseOriginForm,
  sendGenericError,
  sendResponse,
} from '../../src/http-common.js';

function request(address, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: address.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawRequest(address, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
    const chunks = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('latin1'));
    };
    socket.setTimeout(1_000, () => finish(new Error('raw HTTP request timed out')));
    socket.once('connect', () => socket.end(payload, 'latin1'));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => finish());
    socket.once('close', () => finish());
    socket.once('error', finish);
  });
}

test('origin-form parser rejects proxy, traversal, separator, and control forms', () => {
  assert.equal(parseOriginForm('/safe/path').pathname, '/safe/path');
  for (const target of [
    'http://attacker.invalid/safe',
    '//attacker.invalid/safe',
    '/safe\\other',
    '/safe/../other',
    '/safe/%2e%2e/other',
    '/safe%2fother',
    '/safe//other',
    '/safe\u0000',
  ]) {
    assert.throws(() => parseOriginForm(target));
  }
});

test('fixed-window rate limiter is bounded and resets expired keys', () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 100, maxEntries: 2, now: () => now });
  assert.equal(limiter.take('one').allowed, true);
  assert.equal(limiter.take('one').allowed, true);
  assert.equal(limiter.take('one').allowed, false);
  limiter.take('two');
  limiter.take('overflow-a');
  assert.equal(limiter.entries.size, 2);
  assert.equal(limiter.take('overflow-b').allowed, true);
  assert.equal(limiter.take('overflow-c').allowed, false);
  now += 101;
  assert.equal(limiter.take('three').allowed, true);
  assert.ok(limiter.entries.size <= 2);
});

test('HTTP service applies security headers and HEAD suppresses the body', async (t) => {
  const service = createHttpService((req, res) => {
    sendResponse(req, res, 200, 'credential', { 'content-type': 'text/plain; charset=utf-8' });
  }, { host: '127.0.0.1', port: 0 });
  const address = await service.listen();
  t.after(() => service.close());

  const get = await request(address);
  const head = await request(address, { method: 'HEAD' });
  assert.equal(get.body.toString(), 'credential');
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(get.headers['cache-control'], 'no-store');
  assert.equal(get.headers['referrer-policy'], 'no-referrer');
  assert.equal(get.headers['x-content-type-options'], 'nosniff');
  assert.match(get.headers['content-security-policy'], /default-src 'none'/u);
  assert.match(get.headers['content-security-policy'], /frame-ancestors 'none'/u);
});

test('malformed raw HTTP targets and headers return 4xx without terminating the service', async (t) => {
  const service = createHttpService((req, res) => {
    try {
      parseOriginForm(req.url);
      sendResponse(req, res, 200, 'healthy\n', { 'content-type': 'text/plain; charset=utf-8' });
    } catch (error) {
      sendGenericError(req, res, error.status ?? 400);
    }
  }, { host: '127.0.0.1', port: 0 });
  const address = await service.listen();
  t.after(() => service.close());

  const invalidTarget = await rawRequest(
    address,
    'GET http://attacker.invalid/ HTTP/1.1\r\nHost: gateway.test\r\nConnection: close\r\n\r\n',
  );
  assert.match(invalidTarget, /^HTTP\/1\.1 400 /u);

  const invalidHeader = await rawRequest(
    address,
    'GET / HTTP/1.1\r\nHost: gateway.test\r\nBad Header: value\r\nConnection: close\r\n\r\n',
  );
  assert.match(invalidHeader, /^HTTP\/1\.1 400 /u);

  const healthy = await request(address, { headers: { host: 'gateway.test' } });
  assert.equal(healthy.status, 200);
  assert.equal(healthy.body.toString('utf8'), 'healthy\n');
});
