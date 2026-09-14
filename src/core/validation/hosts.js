import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { ValidationError, expectString, expectExactKeys } from './values.js';

function normalizeIpv6(value, path) {
  try {
    const parsed = new URL(`http://[${value}]/`);
    return parsed.hostname.slice(1, -1).toLowerCase();
  } catch {
    throw new ValidationError(path, 'must be a valid IPv6 address');
  }
}

export function normalizeDns(value, path) {
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
