import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  ValidationError,
  expectExactKeys,
  expectInteger,
  expectString,
  validateTokenHash,
  validateUuid,
} from '../validation/values.js';

const scrypt = promisify(scryptCallback);

export const SUBSCRIPTION_TOKEN_BYTES = 32;
export const DEFAULT_SCRYPT_PARAMETERS = Object.freeze({
  keyLength: 32,
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
});

function decodeBase64Url(value, path, { minBytes, maxBytes }) {
  const encoded = expectString(value, path, { min: 1, max: 256 });
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new ValidationError(path, 'must be unpadded base64url');
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.length < minBytes || decoded.length > maxBytes || decoded.toString('base64url') !== encoded) {
    throw new ValidationError(path, `must encode between ${minBytes} and ${maxBytes} bytes`);
  }
  return decoded;
}

function validatePassword(value, path = 'password', { requireMinimum = false } = {}) {
  const password = expectString(value, path, { min: 1, max: 1024, controls: true });
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes > 1024) throw new ValidationError(path, 'must be at most 1024 UTF-8 bytes');
  if (requireMinimum && bytes < 12) throw new ValidationError(path, 'must be at least 12 UTF-8 bytes');
  return password;
}

export function createUuid({ randomUUIDImpl = randomUUID } = {}) {
  return validateUuid(randomUUIDImpl(), 'generatedUuid');
}

export function createSubscriptionToken({ randomBytesImpl = randomBytes } = {}) {
  const token = randomBytesImpl(SUBSCRIPTION_TOKEN_BYTES);
  if (!Buffer.isBuffer(token) || token.length !== SUBSCRIPTION_TOKEN_BYTES) {
    throw new Error('secure random source returned an invalid subscription token');
  }
  return token.toString('base64url');
}

export function validateSubscriptionToken(token, path = 'token') {
  const normalized = expectString(token, path, { min: 32, max: 256 });
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new ValidationError(path, 'must be an unpadded URL-safe token');
  }
  return normalized;
}

export function hashSubscriptionToken(token) {
  const normalized = validateSubscriptionToken(token);
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

export function verifySubscriptionToken(token, expectedHash) {
  try {
    const actual = Buffer.from(hashSubscriptionToken(token).slice('sha256:'.length), 'hex');
    const expected = Buffer.from(validateTokenHash(expectedHash).slice('sha256:'.length), 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function validateScryptRecord(value, path = 'admin.scrypt') {
  const record = expectExactKeys(value, [
    'algorithm',
    'salt',
    'hash',
    'keyLength',
    'cost',
    'blockSize',
    'parallelization',
  ], path);
  if (record.algorithm !== 'scrypt') {
    throw new ValidationError(`${path}.algorithm`, 'must be scrypt');
  }
  const keyLength = expectInteger(record.keyLength, `${path}.keyLength`, { min: 32, max: 64 });
  const cost = expectInteger(record.cost, `${path}.cost`, { min: 16384, max: 262144 });
  if ((cost & (cost - 1)) !== 0) throw new ValidationError(`${path}.cost`, 'must be a power of two');
  const blockSize = expectInteger(record.blockSize, `${path}.blockSize`, { min: 8, max: 16 });
  const parallelization = expectInteger(record.parallelization, `${path}.parallelization`, { min: 1, max: 4 });
  const estimatedMemory = 128 * cost * blockSize + 1024 * blockSize * parallelization;
  if (estimatedMemory > 256 * 1024 * 1024) {
    throw new ValidationError(path, 'parameters exceed the allowed memory bound');
  }
  const salt = decodeBase64Url(record.salt, `${path}.salt`, { minBytes: 16, maxBytes: 64 });
  const hash = decodeBase64Url(record.hash, `${path}.hash`, { minBytes: keyLength, maxBytes: keyLength });
  return {
    algorithm: 'scrypt',
    salt: salt.toString('base64url'),
    hash: hash.toString('base64url'),
    keyLength,
    cost,
    blockSize,
    parallelization,
  };
}

async function derivePassword(password, record) {
  const maxmem = Math.max(
    32 * 1024 * 1024,
    128 * record.cost * record.blockSize + 2 * 1024 * 1024,
  );
  return scrypt(password, Buffer.from(record.salt, 'base64url'), record.keyLength, {
    N: record.cost,
    r: record.blockSize,
    p: record.parallelization,
    maxmem,
  });
}

export async function createAdminScryptRecord(password, {
  randomBytesImpl = randomBytes,
  parameters = DEFAULT_SCRYPT_PARAMETERS,
} = {}) {
  const normalized = validatePassword(password, 'password', { requireMinimum: true });
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new ValidationError('parameters', 'must be an object');
  }
  for (const key of Object.keys(parameters)) {
    if (!Object.hasOwn(DEFAULT_SCRYPT_PARAMETERS, key)) {
      throw new ValidationError(`parameters.${key}`, 'is not allowed');
    }
  }
  const selected = { ...DEFAULT_SCRYPT_PARAMETERS, ...parameters };
  const salt = randomBytesImpl(16);
  if (!Buffer.isBuffer(salt) || salt.length !== 16) {
    throw new Error('secure random source returned an invalid password salt');
  }
  const candidate = validateScryptRecord({
    algorithm: 'scrypt',
    salt: salt.toString('base64url'),
    hash: Buffer.alloc(selected.keyLength).toString('base64url'),
    ...selected,
  });
  const hash = await derivePassword(normalized, candidate);
  return { ...candidate, hash: hash.toString('base64url') };
}

export async function verifyAdminPassword(password, value) {
  try {
    const normalized = validatePassword(password);
    const record = validateScryptRecord(value);
    const actual = await derivePassword(normalized, record);
    const expected = Buffer.from(record.hash, 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
