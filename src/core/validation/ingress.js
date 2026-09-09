import { isIP } from 'node:net';
import { ValidationError, expectString, expectExactKeys } from './values.js';
import { normalizeDns } from './hosts.js';

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
