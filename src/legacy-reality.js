import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
} from 'node:crypto';
import { ValidationError, expectString } from './validation.js';

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function validateLegacyRealityKey(value, path) {
  const key = expectString(value, path, { min: 43, max: 43 });
  if (!/^[A-Za-z0-9_-]{43}$/u.test(key)) {
    throw new ValidationError(path, 'must be a canonical unpadded base64url X25519 key');
  }
  const decoded = Buffer.from(key, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== key) {
    throw new ValidationError(path, 'must encode exactly 32 bytes');
  }
  return key;
}

function deriveLegacyRealityPublicKey(value, path) {
  const privateKey = validateLegacyRealityKey(value, path);
  try {
    const key = createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(privateKey, 'base64url')]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
    if (
      !Buffer.isBuffer(spki)
      || spki.length !== X25519_SPKI_PREFIX.length + 32
      || !timingSafeEqual(spki.subarray(0, X25519_SPKI_PREFIX.length), X25519_SPKI_PREFIX)
    ) throw new Error('unexpected public key encoding');
    return spki.subarray(X25519_SPKI_PREFIX.length).toString('base64url');
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(path, 'must be a valid X25519 private key');
  }
}

export function validateLegacyRealityKeyPair(privateValue, publicValue, {
  privatePath = 'privateKey',
  publicPath = 'publicKey',
} = {}) {
  const privateKey = validateLegacyRealityKey(privateValue, privatePath);
  const publicKey = validateLegacyRealityKey(publicValue, publicPath);
  const derived = Buffer.from(deriveLegacyRealityPublicKey(privateKey, privatePath), 'base64url');
  const supplied = Buffer.from(publicKey, 'base64url');
  if (!timingSafeEqual(derived, supplied)) {
    throw new ValidationError(publicPath, 'must correspond to the configured X25519 private key');
  }
  return { privateKey, publicKey };
}

export function validateLegacyRealityShortId(value, path = 'shortId') {
  const shortId = expectString(value, path, { min: 2, max: 16 }).toLowerCase();
  if (!/^(?:[0-9a-f]{2}){1,8}$/u.test(shortId)) {
    throw new ValidationError(path, 'must contain 1 to 8 bytes of hexadecimal data');
  }
  return shortId;
}
