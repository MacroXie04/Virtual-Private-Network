import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubscriptionProxy } from '../../src/http/admin/subscriptions.js';
import { proxyFixture, endResponse } from '../helpers/subscription-proxy.js';

test('proxy rejects invalid configured destinations before accepting a request', () => {
  for (const port of [0, -1, 65536, NaN, 8080.5]) {
    assert.throws(() => createSubscriptionProxy({ publicHostname: 'admin.example.com', port }));
  }
  for (const publicHostname of ['localhost', '127.0.0.1', 'admin.example.com:443', 'https://admin.example.com']) {
    assert.throws(() => createSubscriptionProxy({ publicHostname }));
  }
});

test('proxy discards private upstream error bodies and does not follow redirects', async () => {
  for (const status of [301, 401, 500, 404, 429, 503]) {
    const fixture = proxyFixture({ status, headers: { location: 'https://attacker.invalid/', 'set-cookie': 'secret' } });
    fixture.connect();
    endResponse(fixture.incoming, 'private upstream error details');
    assert.equal(await fixture.pending, true);
    assert.equal(fixture.res.statusCode, [404, 429, 503].includes(status) ? status : 503);
    assert.doesNotMatch(fixture.res.body.toString(), /private|secret/u);
    assert.equal(fixture.res.headers.location, undefined);
    assert.equal(fixture.res.headers['set-cookie'], undefined);
    assert.equal(fixture.res.headers['cache-control'], 'no-store');
  }
});

test('proxy bounds both declared and streamed response bytes before disclosing any body', async () => {
  const declared = proxyFixture({ headers: { 'content-length': String(1024 * 1024 + 1) } });
  declared.connect();
  await declared.pending;
  assert.equal(declared.res.statusCode, 503);
  assert.equal(declared.incoming.destroyed, true);
  assert.equal(declared.upstream.destroyed, true);

  const streamed = proxyFixture();
  streamed.connect();
  streamed.incoming.emit('data', Buffer.alloc(1024 * 1024));
  assert.equal(streamed.res.headersSent, false);
  streamed.incoming.emit('data', Buffer.from('extra-private-byte'));
  await streamed.pending;
  assert.equal(streamed.res.statusCode, 503);
  assert.equal(streamed.res.body.toString(), 'Service Unavailable\n');
  assert.equal(streamed.incoming.destroyed, true);
  assert.equal(streamed.upstream.destroyed, true);
});

test('proxy enforces a total deadline even before response headers arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = proxyFixture();
  t.mock.timers.tick(9_999);
  assert.equal(fixture.res.headersSent, false);
  t.mock.timers.tick(1);
  assert.equal(await fixture.pending, true);
  assert.equal(fixture.res.statusCode, 503);
  assert.equal(fixture.upstream.destroyed, true);
});

test('a slow response cannot extend the total deadline by sending more bytes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = proxyFixture();
  fixture.connect();
  fixture.incoming.emit('data', Buffer.from('private-partial'));
  t.mock.timers.tick(9_999);
  fixture.incoming.emit('data', Buffer.from('still-incomplete'));
  t.mock.timers.tick(1);
  await fixture.pending;
  assert.equal(fixture.res.statusCode, 503);
  assert.equal(fixture.res.body.toString(), 'Service Unavailable\n');
  assert.equal(fixture.incoming.destroyed, true);
});

test('client disconnect destroys pending transports without sending a response', async () => {
  for (const event of ['aborted', 'close']) {
    const fixture = proxyFixture();
    fixture.connect();
    if (event === 'aborted') fixture.req.emit('aborted');
    else fixture.res.emit('close');
    assert.equal(await fixture.pending, true);
    assert.equal(fixture.upstream.destroyed, true);
    assert.equal(fixture.incoming.destroyed, true);
    assert.equal(fixture.res.headersSent, false);
    assert.equal(fixture.req.listenerCount('aborted'), 0);
    assert.equal(fixture.res.listenerCount('close'), 0);
  }
});

test('upstream errors, incomplete responses, and size mismatches fail closed', async () => {
  for (const failure of ['request-error', 'response-error', 'aborted', 'close', 'size']) {
    const fixture = proxyFixture({ headers: { 'content-length': '123' } });
    if (failure === 'request-error') fixture.upstream.emit('error', new Error('private detail'));
    else {
      fixture.connect();
      if (failure === 'size') endResponse(fixture.incoming, 'short');
      else fixture.incoming.emit(failure === 'response-error' ? 'error' : failure, new Error('private detail'));
    }
    await fixture.pending;
    assert.equal(fixture.res.statusCode, 503);
    assert.equal(fixture.res.body.toString(), 'Service Unavailable\n');
    assert.equal(fixture.upstream.destroyed, true);
  }
});

test('HEAD requires bounded metadata and returns the GET representation length without its body', async () => {
  const fixture = proxyFixture({ method: 'HEAD', headers: { 'content-length': '512', 'content-type': 'text/plain' } });
  fixture.connect();
  endResponse(fixture.incoming);
  await fixture.pending;
  assert.equal(fixture.res.statusCode, 200);
  assert.equal(fixture.res.headers['content-length'], '512');
  assert.equal(fixture.res.headers['cache-control'], 'no-store');
  assert.equal(fixture.res.body.length, 0);
  const missingLength = proxyFixture({ method: 'HEAD' });
  missingLength.connect();
  await missingLength.pending;
  assert.equal(missingLength.res.statusCode, 503);
});
