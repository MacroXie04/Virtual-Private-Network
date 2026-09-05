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
  return validateSubscriptionPublicBaseUrl(value, path);
}

/** A public Tunnel route must be one canonical, multi-label DNS hostname. */
export function validatePublicDnsHostname(value, path = 'hostname') {
  const raw = expectString(value, path, { min: 3, max: 253 });
  if (
    raw !== raw.trim()
    || raw.endsWith('.')
    || raw.startsWith('[')
    || raw.endsWith(']')
    || isIP(raw) !== 0
  ) {
    throw new ValidationError(path, 'must be an unbracketed public DNS hostname without a trailing dot');
  }
  const hostname = normalizeDns(raw, path);
  if (
    isIP(hostname) !== 0
    || !hostname.includes('.')
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
  ) {
    throw new ValidationError(path, 'must be a multi-label public DNS hostname');
  }
  return hostname;
}

/** The subscription origin has no path or alternate port: Cloudflare serves it on HTTPS 443. */
export function validateSubscriptionPublicBaseUrl(value, path = 'subscriptionPublicBaseUrl') {
  const raw = expectString(value, path, { min: 9, max: 2048 });
  if (
    raw !== raw.trim()
    || raw.includes('\\')
    || raw.endsWith('/')
    || !/^https:\/\/[^/]+$/iu.test(raw)
  ) {
    throw new ValidationError(path, 'must be an HTTPS origin without a path');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(path, 'must be an absolute HTTPS origin');
  }
  if (parsed.protocol !== 'https:') throw new ValidationError(path, 'must use https');
  if (parsed.username || parsed.password) throw new ValidationError(path, 'must not contain credentials');
  if (parsed.search || parsed.hash) throw new ValidationError(path, 'must not contain a query or fragment');
  if (parsed.pathname !== '/') throw new ValidationError(path, 'must not contain a path');
  const hostname = validatePublicDnsHostname(parsed.hostname, `${path}.hostname`);
  const authority = raw.slice('https://'.length);
  if (authority.toLowerCase() !== hostname) {
    throw new ValidationError(path, 'must not contain an explicit port or non-canonical authority');
  }
  return `https://${hostname}`;
}

export function validateWebSocketPath(value, path = 'websocketPath') {
  const websocketPath = expectString(value, path, { min: 44, max: 129 });
  if (!/^\/[A-Za-z0-9_-]{43,128}$/u.test(websocketPath)) {
    throw new ValidationError(
      path,
      'must be one absolute URL-safe segment containing 43 to 128 characters',
    );
  }
  return websocketPath;
}

export function validatePublicIngressSettings(value, path = 'gateway') {
  const gateway = expectExactKeys(value, [
    'vpnPublicHostname',
    'subscriptionPublicBaseUrl',
    'adminPublicHostname',
    'websocketPath',
  ], path);
  const vpnPublicHostname = validatePublicDnsHostname(
    gateway.vpnPublicHostname,
    `${path}.vpnPublicHostname`,
  );
  const subscriptionPublicBaseUrl = validateSubscriptionPublicBaseUrl(
    gateway.subscriptionPublicBaseUrl,
    `${path}.subscriptionPublicBaseUrl`,
  );
  const subscriptionHostname = new URL(subscriptionPublicBaseUrl).hostname;
  const adminPublicHostname = validatePublicDnsHostname(
    gateway.adminPublicHostname,
    `${path}.adminPublicHostname`,
  );
  if (new Set([vpnPublicHostname, subscriptionHostname, adminPublicHostname]).size !== 3) {
    throw new ValidationError(path, 'VPN, subscription, and administration hostnames must be distinct');
  }
  return {
    vpnPublicHostname,
    subscriptionPublicBaseUrl,
    adminPublicHostname,
    websocketPath: validateWebSocketPath(gateway.websocketPath, `${path}.websocketPath`),
  };
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
