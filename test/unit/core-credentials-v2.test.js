import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAdminScryptRecord,
  createSubscriptionToken,
  createUuid,
  hashSubscriptionToken,
  validateScryptRecord,
  verifyAdminPassword,
  verifySubscriptionToken,
  validateSubscriptionToken,
} from '../../src/credentials.js';

test('subscription tokens use 256 random bits and persist only as fixed hashes', () => {
  const token = createSubscriptionToken({ randomBytesImpl: (size) => Buffer.alloc(size, 7) });
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(token.includes('='), false);
  const hash = hashSubscriptionToken(token);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(verifySubscriptionToken(token, hash), true);
  assert.equal(verifySubscriptionToken(`${token}x`, hash), false);
  assert.equal(verifySubscriptionToken(token, 'not-a-hash'), false);
  assert.equal(validateSubscriptionToken('a'.repeat(32)), 'a'.repeat(32));
  assert.throws(() => validateSubscriptionToken('a'.repeat(31)), /URL-safe|length/u);
  assert.throws(() => validateSubscriptionToken(`${'a'.repeat(31)}/`), /URL-safe/u);
  assert.throws(() => hashSubscriptionToken(`${'a'.repeat(31)}+`), /URL-safe/u);
});

test('UUID generation validates the secure source result', () => {
  assert.equal(
    createUuid({ randomUUIDImpl: () => '00000000-0000-4000-8000-000000000123' }),
    '00000000-0000-4000-8000-000000000123',
  );
  assert.throws(() => createUuid({ randomUUIDImpl: () => '../unsafe' }), /generatedUuid/);
});

test('admin credentials are bounded scrypt records and verify without storing a password', async () => {
  const record = await createAdminScryptRecord('correct horse battery staple', {
    randomBytesImpl: (size) => Buffer.alloc(size, 11),
  });
  assert.deepEqual(validateScryptRecord(record), record);
  assert.equal(Object.hasOwn(record, 'password'), false);
  assert.equal(record.algorithm, 'scrypt');
  assert.equal(await verifyAdminPassword('correct horse battery staple', record), true);
  assert.equal(await verifyAdminPassword('wrong password', record), false);
  assert.equal(await verifyAdminPassword('correct horse battery staple', { ...record, cost: 16385 }), false);
});

test('admin password creation enforces a meaningful minimum and parameter memory bound', async () => {
  await assert.rejects(createAdminScryptRecord('too-short'), /at least 12/);
  const record = {
    algorithm: 'scrypt',
    salt: Buffer.alloc(16).toString('base64url'),
    hash: Buffer.alloc(32).toString('base64url'),
    keyLength: 32,
    cost: 262144,
    blockSize: 16,
    parallelization: 1,
  };
  assert.throws(() => validateScryptRecord(record), /memory bound/);
});
