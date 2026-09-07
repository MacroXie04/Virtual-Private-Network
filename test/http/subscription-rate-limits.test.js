import assert from 'node:assert/strict';

import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSubscriptionServer } from '../../src/http/subscription-application.js';

import { FixedWindowRateLimiter } from '../../src/http/rate-limit.js';

import { request, projection, tokenHash } from '../helpers/subscription-http.js';

test('subscription server enforces its request limiter with a real 429 response', async (t) => {
  const token = 'J'.repeat(43);
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => projection(token),
    checkMaintenance: async () => false,
    rateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 8,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  // Arbitrary paths use only the high global guard and cannot spend a valid
  // credential's own allowance.
  assert.equal((await request(address, '/not-a-subscription')).status, 404);
  assert.equal((await request(address, `/s/${token}/links`, {
    headers: { 'x-forwarded-for': '198.51.100.1' },
  })).status, 200);
  const limited = await request(address, `/s/${token}/links`, {
    headers: { 'x-forwarded-for': '198.51.100.2' },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(limited.body.toString('utf8'), 'Too Many Requests\n');
});

test('malformed aggregate throttling cannot block a verified subscription', async (t) => {
  const token = 'O'.repeat(43);
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => projection(token),
    checkMaintenance: async () => false,
    globalRateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 2,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  assert.equal((await request(address, '/not-a-subscription')).status, 404);
  assert.equal((await request(address, '/still-not-a-subscription')).status, 429);
  assert.equal((await request(address, `/s/${token}/links`)).status, 200);
});

test('valid subscription credentials have independent proxy-safe rate buckets', async (t) => {
  const tokenA = 'L'.repeat(43);
  const tokenB = 'M'.repeat(43);
  const view = projection(tokenA);
  view.users.push({
    id: 'bob',
    displayName: 'Bob',
    uuid: '123e4567-e89b-42d3-a456-426614174003',
    tokenHash: tokenHash(tokenB),
  });
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => view,
    checkMaintenance: async () => false,
    rateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 8,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  assert.equal((await request(address, `/s/${tokenA}/links`)).status, 200);
  assert.equal((await request(address, `/s/${tokenB}/links`)).status, 200);
  assert.equal((await request(address, `/s/${tokenA}/links`)).status, 429);
});

test('invalid-token floods cannot consume the bounded valid-credential limiter', async (t) => {
  const validToken = 'N'.repeat(43);
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => projection(validToken),
    checkMaintenance: async () => false,
    rateLimiter: new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxEntries: 2,
      now: () => 1_000,
    }),
    invalidTokenRateLimiter: new FixedWindowRateLimiter({
      limit: 100,
      windowMs: 60_000,
      maxEntries: 2,
      now: () => 1_000,
    }),
  });
  const address = await service.listen();
  t.after(() => service.close());

  for (let index = 0; index < 20; index += 1) {
    const guessed = `${String(index).padStart(2, '0')}${'G'.repeat(41)}`;
    assert.equal((await request(address, `/s/${guessed}/links`)).status, 404);
  }
  assert.equal((await request(address, `/s/${validToken}/links`)).status, 200);
  assert.equal((await request(address, `/s/${validToken}/links`)).status, 429);
});
