import { createHash, createHmac } from 'node:crypto';
import { classifyHost } from '../validation/hosts.js';
import { expectString, ValidationError, validateUuid } from '../validation/values.js';

export const MAX_EXTRA_EXITS = 15;

export function exitProfileId(deviceId) {
  const value = expectString(deviceId, 'deviceId', { min: 1, max: 128 });
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ValidationError('deviceId', 'must be a safe Tailscale device identifier');
  }
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function validateExitProfileId(value, path = 'exitId') {
  const id = expectString(value, path, { min: 16, max: 16 });
  if (!/^[0-9a-f]{16}$/u.test(id)) {
    throw new ValidationError(path, 'must be 16 lowercase hexadecimal characters');
  }
  return id;
}

export function validateExitAddress(value, path = 'exitAddress') {
  const host = classifyHost(value, path);
  const [first, second] = host.value.split('.').map(Number);
  if ((host.kind === 'ipv4' && first === 100 && second >= 64 && second <= 127)
    || (host.kind === 'ipv6' && host.value.startsWith('fd7a:115c:a1e0:'))) {
    return host.value;
  }
  throw new ValidationError(path, 'must be a Tailscale IPv4 or IPv6 address');
}

export function deriveExitUuid(userUuid, exitId) {
  const key = validateUuid(userUuid, 'userUuid');
  const id = validateExitProfileId(exitId);
  // This context is part of the persistent client credential contract.
  const bytes = createHmac('sha256', key)
    .update(`vpn-gateway:exit-uuid:v1:${id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveExitHealthPassword(password, exitId) {
  const key = expectString(password, 'healthPassword', { min: 43, max: 43 });
  const id = validateExitProfileId(exitId);
  return createHmac('sha256', key).update(`vpn-gateway:exit-health:v1:${id}`).digest('base64url');
}
