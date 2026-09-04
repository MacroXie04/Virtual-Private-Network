import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export class ValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'ValidationError';
    this.code = 'INVALID_STATE';
    this.path = path;
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function expectObject(value, path) {
  if (!isPlainObject(value)) throw new ValidationError(path, 'must be an object');
  return value;
}

export function expectExactKeys(value, allowed, path) {
  expectObject(value, path);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new ValidationError(`${path}.${key}`, 'is not allowed');
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new ValidationError(`${path}.${key}`, 'is required');
  }
  return value;
}

export function expectString(value, path, { min = 1, max = 4096, controls = false } = {}) {
  if (typeof value !== 'string') throw new ValidationError(path, 'must be a string');
  if (value.length < min || value.length > max) {
    throw new ValidationError(path, `length must be between ${min} and ${max}`);
  }
  if (!controls && /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ValidationError(path, 'must not contain control characters');
  }
  return value;
}

export function expectNullableString(value, path, options) {
  return value === null ? null : expectString(value, path, options);
}

export function expectInteger(value, path, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(path, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function validatePort(value, path = 'port') {
  return expectInteger(value, path, { min: 1, max: 65535 });
}

export function validateUuid(value, path = 'uuid') {
  const uuid = expectString(value, path, { min: 36, max: 36 }).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(uuid)) {
    throw new ValidationError(path, 'must be a canonical UUID');
  }
  return uuid;
}

export function validateTimestamp(value, path = 'timestamp') {
  const timestamp = expectString(value, path, { min: 20, max: 30 });
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new ValidationError(path, 'must be a canonical RFC 3339 UTC timestamp');
  }
  return timestamp;
}

function normalizeIpv6(value, path) {
  try {
    const parsed = new URL(`http://[${value}]/`);
    return parsed.hostname.slice(1, -1).toLowerCase();
  } catch {
    throw new ValidationError(path, 'must be a valid IPv6 address');
  }
}

function normalizeDns(value, path) {
  if (value.endsWith('.')) value = value.slice(0, -1);
  const ascii = domainToASCII(value).toLowerCase();
  if (!ascii || ascii.length > 253) throw new ValidationError(path, 'must be a valid DNS name');
  const labels = ascii.split('.');
  if (labels.some((label) => (
    label.length < 1
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ))) {
    throw new ValidationError(path, 'must be a valid DNS name');
  }
  return ascii;
}

export function classifyHost(value, path = 'host') {
  const host = expectString(value, path, { min: 1, max: 253 });
  if (host !== host.trim() || host.startsWith('[') || host.endsWith(']')) {
    throw new ValidationError(path, 'must be an unbracketed host without surrounding whitespace');
  }
  const version = isIP(host);
  if (version === 4) {
    return { kind: 'ipv4', value: host.split('.').map((part) => String(Number(part))).join('.') };
  }
  if (version === 6) return { kind: 'ipv6', value: normalizeIpv6(host, path) };
  return { kind: 'dns', value: normalizeDns(host, path) };
}

export function validateHostRecord(value, path = 'host') {
  const host = expectExactKeys(value, ['kind', 'value'], path);
  if (!['dns', 'ipv4', 'ipv6'].includes(host.kind)) {
    throw new ValidationError(`${path}.kind`, 'must be dns, ipv4, or ipv6');
  }
  const normalized = classifyHost(host.value, `${path}.value`);
  if (normalized.kind !== host.kind) {
    throw new ValidationError(`${path}.kind`, `does not match ${normalized.kind} value`);
  }
  return normalized;
}

export function formatAuthorityHost(host, path = 'host') {
  const normalized = validateHostRecord(host, path);
  return normalized.kind === 'ipv6' ? `[${normalized.value}]` : normalized.value;
}

export function validatePublicBaseUrl(value, path = 'publicBaseUrl') {
  if (value === null) return null;
  const raw = expectString(value, path, { min: 9, max: 2048 });
  if (raw !== raw.trim() || /%(?:0[0-9a-f]|1[0-9a-f]|2e|2f|5c|7f)/iu.test(raw) || raw.includes('\\')) {
    throw new ValidationError(path, 'contains an unsafe encoded character or separator');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(path, 'must be an absolute URL');
  }
  if (parsed.protocol !== 'https:') throw new ValidationError(path, 'must use https');
  if (parsed.username || parsed.password) throw new ValidationError(path, 'must not contain credentials');
  if (parsed.search || parsed.hash) throw new ValidationError(path, 'must not contain a query or fragment');
  if (parsed.port && parsed.port !== '443') throw new ValidationError(path, 'must use port 443');
  const urlHost = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  classifyHost(urlHost, `${path}.host`);
  if (parsed.pathname.includes('//')) throw new ValidationError(path, 'must not contain empty path segments');
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '');
  return `${parsed.origin}${pathname}`;
}

export function normalizeDisplayName(value, path = 'displayName') {
  const name = expectString(value, path, { min: 1, max: 128 }).normalize('NFC');
  if (name !== name.trim()) throw new ValidationError(path, 'must not have leading or trailing whitespace');
  if ([...name].length > 64) throw new ValidationError(path, 'must be at most 64 characters');
  if (/[\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new ValidationError(path, 'must not contain invisible formatting or line-separator characters');
  }
  return name;
}

export function validateShortId(value, path = 'shortId') {
  const shortId = expectString(value, path, { min: 2, max: 16 }).toLowerCase();
  if (!/^(?:[0-9a-f]{2}){1,8}$/u.test(shortId)) {
    throw new ValidationError(path, 'must contain 1 to 8 bytes of hexadecimal data');
  }
  return shortId;
}

export function validateKeyMaterial(value, path) {
  const key = expectString(value, path, { min: 1, max: 256 });
  if (!/^[A-Za-z0-9_-]{43}$/u.test(key)) {
    throw new ValidationError(path, 'must be a canonical unpadded base64url X25519 key');
  }
  const decoded = Buffer.from(key, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== key) {
    throw new ValidationError(path, 'must encode exactly 32 bytes');
  }
  return key;
}

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** Derive the REALITY/X25519 public key from its canonical raw private key. */
export function deriveRealityPublicKey(value, path = 'privateKey') {
  const privateKey = validateKeyMaterial(value, path);
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
    ) {
      throw new Error('unexpected public key encoding');
    }
    return spki.subarray(X25519_SPKI_PREFIX.length).toString('base64url');
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(path, 'must be a valid X25519 private key');
  }
}

export function validateRealityKeyPair(privateValue, publicValue, {
  privatePath = 'privateKey',
  publicPath = 'publicKey',
} = {}) {
  const privateKey = validateKeyMaterial(privateValue, privatePath);
  const publicKey = validateKeyMaterial(publicValue, publicPath);
  const derived = Buffer.from(deriveRealityPublicKey(privateKey, privatePath), 'base64url');
  const supplied = Buffer.from(publicKey, 'base64url');
  if (!timingSafeEqual(derived, supplied)) {
    throw new ValidationError(publicPath, 'must correspond to the configured X25519 private key');
  }
  return { privateKey, publicKey };
}

export function validateTokenHash(value, path = 'tokenHash') {
  const hash = expectString(value, path, { min: 71, max: 71 }).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/u.test(hash)) {
    throw new ValidationError(path, 'must be a SHA-256 token hash');
  }
  return hash;
}

export function validateAbsoluteStatePath(value, path = 'path') {
  const statePath = expectString(value, path, { min: 2, max: 4096 });
  const segments = statePath.split('/');
  if (
    !statePath.startsWith('/')
    || statePath.endsWith('/')
    || statePath.includes('//')
    || statePath.includes('\\')
    || segments.includes('.')
    || segments.includes('..')
  ) {
    throw new ValidationError(path, 'must be a normalized absolute path');
  }
  return statePath;
}

export function safeYamlScalar(value) {
  return JSON.stringify(String(value))
    .replaceAll('\u0085', '\\u0085')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}
