import path from 'node:path';
import { validateAbsoluteStatePath } from '../../core/validation/values.js';

export function safeInteger(value, name, { min = 0, max = 2_147_483_647 } = {}) {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
    throw new TypeError(`${name} is invalid`);
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

export function absolutePath(value, name) {
  const result = validateAbsoluteStatePath(value, name);
  if (path.normalize(result) !== result) throw new TypeError(`${name} must be normalized`);
  return result;
}

export function childEnvironment(entries) {
  const result = {
    NODE_ENV: 'production',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
  for (const [name, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null && value !== '') result[name] = String(value);
  }
  return result;
}
