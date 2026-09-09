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

export function normalizeDisplayName(value, path = 'displayName') {
  const name = expectString(value, path, { min: 1, max: 128 }).normalize('NFC');
  if (name !== name.trim()) throw new ValidationError(path, 'must not have leading or trailing whitespace');
  if ([...name].length > 64) throw new ValidationError(path, 'must be at most 64 characters');
  if (/[\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new ValidationError(path, 'must not contain invisible formatting or line-separator characters');
  }
  return name;
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
