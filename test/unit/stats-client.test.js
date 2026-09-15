import assert from 'node:assert/strict';
import http2 from 'node:http2';
import test from 'node:test';
import {
  decodeFields, encodeBoolField, encodeStringField, encodeVarint, int64FromVarint,
} from '../../src/runtime/stats/protobuf.js';
import { frameMessage, grpcUnary, unframeMessages } from '../../src/runtime/stats/grpc.js';
import { QUERY_STATS_METHOD, parseUserCounter, queryTrafficCounters } from '../../src/runtime/stats/client.js';

function varintField(fieldNumber, value) {
  return Buffer.concat([encodeVarint(fieldNumber << 3), encodeVarint(value)]);
}

function stat(name, value) {
  const message = Buffer.concat([encodeStringField(1, name), varintField(2, value)]);
  return Buffer.concat([encodeVarint((1 << 3) | 2), encodeVarint(message.length), message]);
}

async function statsServer(t, handler) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => sessions.add(session));
  server.on('stream', handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

function respondWithStats(stream, body, status = '0') {
  stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
  stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': status }));
  stream.end(body);
}

test('protobuf helpers round-trip varints, strings, booleans and int64 values', () => {
  assert.deepEqual([...encodeVarint(0)], [0]);
  assert.deepEqual([...encodeVarint(300)], [0xac, 0x02]);
  assert.throws(() => encodeVarint(-1), TypeError);
  assert.deepEqual(decodeFields(encodeStringField(1, 'abc')), [{ fieldNumber: 1, wireType: 2, value: Buffer.from('abc') }]);
  assert.equal(encodeBoolField(2, false).length, 0);
  assert.deepEqual([...encodeBoolField(2, true)], [0x10, 0x01]);
  assert.deepEqual(decodeFields(varintField(2, 1234)), [{ fieldNumber: 2, wireType: 0, value: 1234n }]);
  assert.equal(int64FromVarint((1n << 64n) - 1n), -1);
  assert.equal(int64FromVarint(2n ** 40n), 2 ** 40);
  assert.throws(() => int64FromVarint(1n << 63n), RangeError);
  assert.throws(() => decodeFields(Buffer.from([0x0a, 0x05, 0x61])), /truncated/u);
  assert.throws(() => decodeFields(Buffer.from([0x0b])), /unsupported wire type/u);
  const fixed = Buffer.concat([Buffer.from([0x09]), Buffer.alloc(8, 1), Buffer.from([0x15]), Buffer.alloc(4, 2)]);
  assert.deepEqual(decodeFields(fixed).map((field) => [field.wireType, field.value.length]), [[1, 8], [5, 4]]);
  assert.deepEqual(unframeMessages(Buffer.concat([frameMessage(Buffer.from('a')), frameMessage(Buffer.alloc(0))])), [Buffer.from('a'), Buffer.alloc(0)]);
  assert.throws(() => unframeMessages(Buffer.from([1, 0, 0, 0, 0])), /compressed/u);
  assert.throws(() => unframeMessages(Buffer.from([0, 0, 0, 0, 9, 1])), /truncated gRPC frame/u);
});

test('queryTrafficCounters performs one framed unary call and decodes every stat', async (t) => {
  let seen;
  const port = await statsServer(t, (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      seen = { headers, body: Buffer.concat(chunks) };
      respondWithStats(stream, frameMessage(Buffer.concat([
        stat('user>>>alice>>>traffic>>>uplink', 1234),
        stat('user>>>alice>>>traffic>>>downlink', 5678901234),
        stat('inbound>>>vless-in>>>traffic>>>uplink', 9),
      ])));
    });
  });
  const counters = await queryTrafficCounters({ port, timeoutMs: 2_000 });
  assert.deepEqual(counters, [
    { name: 'user>>>alice>>>traffic>>>uplink', value: 1234 },
    { name: 'user>>>alice>>>traffic>>>downlink', value: 5678901234 },
    { name: 'inbound>>>vless-in>>>traffic>>>uplink', value: 9 },
  ]);
  assert.equal(seen.headers[':method'], 'POST');
  assert.equal(seen.headers[':path'], QUERY_STATS_METHOD);
  assert.equal(seen.headers['content-type'], 'application/grpc');
  assert.equal(seen.headers.te, 'trailers');
  assert.deepEqual(unframeMessages(seen.body), [encodeStringField(1, 'user>>>')]);
  assert.deepEqual(await queryTrafficCounters({ port, pattern: '' }).then((list) => list.length), 3);
});

test('gRPC failures, oversized replies and timeouts reject without hanging', async (t) => {
  const failing = await statsServer(t, (stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '2' });
    stream.end();
  });
  await assert.rejects(queryTrafficCounters({ port: failing, timeoutMs: 2_000 }), /gRPC status 2/u);
  const silent = await statsServer(t, () => {});
  await assert.rejects(queryTrafficCounters({ port: silent, timeoutMs: 200 }), /timed out/u);
  const badStatus = await statsServer(t, (stream) => {
    stream.respond({ ':status': 404 });
    stream.end();
  });
  await assert.rejects(queryTrafficCounters({ port: badStatus, timeoutMs: 2_000 }), /transport status 404/u);
  const garbage = await statsServer(t, (stream) => respondWithStats(stream, Buffer.from([1, 0, 0, 0, 0])));
  await assert.rejects(queryTrafficCounters({ port: garbage, timeoutMs: 2_000 }), /compressed/u);
  assert.throws(() => grpcUnary({ host: '127.0.0.1', port: 1, method: 'no-slash', message: Buffer.alloc(0) }), TypeError);
});

test('user counters map to gateway users, exits and directions', () => {
  assert.deepEqual(parseUserCounter('user>>>alice>>>traffic>>>uplink'), { userId: 'alice', exitId: null, direction: 'uplink' });
  assert.deepEqual(
    parseUserCounter('user>>>alice@0123456789abcdef>>>traffic>>>downlink'),
    { userId: 'alice', exitId: '0123456789abcdef', direction: 'downlink' },
  );
  assert.equal(parseUserCounter('inbound>>>vless-in>>>traffic>>>uplink'), null);
  assert.equal(parseUserCounter('user>>>bad name>>>traffic>>>uplink'), null);
  assert.equal(parseUserCounter('user>>>alice>>>traffic>>>sideways'), null);
  assert.equal(parseUserCounter(42), null);
});
