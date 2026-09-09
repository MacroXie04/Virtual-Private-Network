import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HEALTH_PASSWORD_BYTES, HEALTH_USERNAME } from '../../../core/model/policy.js';
import { safeLstat, readSecretFile, writePrivateFileExclusive } from './files.js';
import { BootstrapError } from '../errors.js';

const ADMIN_SECRET_BYTES = 32;

function secureRandom(size, randomBytesImpl, description) {
  const value = randomBytesImpl(size);
  if (!Buffer.isBuffer(value) || value.length !== size) {
    throw new BootstrapError('RANDOM_SOURCE_FAILED', `${description} could not be generated securely`);
  }
  return value;
}

export function generateHealthCredentials(randomBytesImpl = randomBytes) {
  return Object.freeze({
    username: HEALTH_USERNAME,
    password: secureRandom(
      HEALTH_PASSWORD_BYTES,
      randomBytesImpl,
      'health probe password',
    ).toString('base64url'),
  });
}

function canonicalAdminSecret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new BootstrapError('INVALID_ADMIN_SECRET', 'administrator secret file has invalid content');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== ADMIN_SECRET_BYTES || decoded.toString('base64url') !== value) {
    throw new BootstrapError('INVALID_ADMIN_SECRET', 'administrator secret file has invalid content');
  }
  return value;
}

export async function prepareAdminSecret(dataDir, { randomBytesImpl = randomBytes } = {}) {
  const secretPath = path.join(dataDir, 'admin-secret');
  const stat = await safeLstat(secretPath);
  if (stat !== null) {
    const secret = canonicalAdminSecret(await readSecretFile(secretPath, {
      description: 'administrator secret file',
      minLength: 43,
      maxLength: 43,
      maxBytes: 64,
    }));
    return { secret, secretPath, needsWrite: false };
  }
  return {
    secret: secureRandom(ADMIN_SECRET_BYTES, randomBytesImpl, 'administrator secret').toString('base64url'),
    secretPath,
    needsWrite: true,
  };
}

export async function persistPreparedAdminSecret(prepared) {
  if (prepared.needsWrite) {
    await writePrivateFileExclusive(prepared.secretPath, Buffer.from(`${prepared.secret}\n`, 'utf8'));
  }
}

export function generateWebSocketPath(randomBytesImpl = randomBytes) {
  return `/${secureRandom(32, randomBytesImpl, 'WebSocket path').toString('base64url')}`;
}
