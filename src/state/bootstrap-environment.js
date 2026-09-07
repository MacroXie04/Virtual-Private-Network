import path from 'node:path';
import { RevisionRepository } from './repository.js';
import {
  ValidationError,
  validatePort,
  validatePublicDnsHostname,
  validatePublicIngressSettings,
  validateTimestamp,
  validateWebSocketPath,
} from '../core/validation.js';
import { absolutePath } from './bootstrap-files.js';
import { BootstrapError } from './bootstrap-errors.js';

export function envString(env, name, { required = true, fallback } = {}) {
  const value = env[name] === undefined || env[name] === '' ? fallback : env[name];
  if (value === undefined || value === null || value === '') {
    if (required) throw new BootstrapError('MISSING_CONFIGURATION', `${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ValidationError(name, 'must be a non-empty string without control characters');
  }
  return value;
}

export function envPort(env, names, fallback) {
  const name = names.find((candidate) => env[candidate] !== undefined && env[candidate] !== '');
  if (name === undefined) return validatePort(fallback, names[0]);
  const raw = env[name];
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,4}$/u.test(raw)) {
    throw new ValidationError(name, 'must be a decimal TCP port');
  }
  return validatePort(Number(raw), name);
}

function optionalGid(env, name) {
  if (env[name] === undefined || env[name] === '') return null;
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(env[name])) throw new ValidationError(name, 'must be a gid');
  const gid = Number(env[name]);
  if (!Number.isSafeInteger(gid) || gid > 2_147_483_647) throw new ValidationError(name, 'must be a gid');
  return gid;
}

export function resolveTime(now) {
  const value = typeof now === 'function' ? now() : now;
  return validateTimestamp(value instanceof Date ? value.toISOString() : value, 'now');
}

export function resolveRepository(env, dataDir, repository) {
  if (repository) return repository;
  return new RevisionRepository(dataDir, {
    runtimeGid: optionalGid(env, 'SINGBOX_GID'),
    subscriptionGid: optionalGid(env, 'SUB_GID'),
    // This process runs before any service is published and is the only place
    // allowed to recognize the immediately previous REALITY schema.
    allowLegacyMigration: true,
  });
}

export function ingressEnvironment(env, websocketPath = null) {
  const configuredPath = env.WS_PATH === undefined || env.WS_PATH === ''
    ? websocketPath
    : validateWebSocketPath(envString(env, 'WS_PATH'), 'WS_PATH');
  const gateway = validatePublicIngressSettings({
    vpnPublicHostname: envString(env, 'VPN_PUBLIC_HOSTNAME'),
    subscriptionPublicBaseUrl: envString(env, 'SUBSCRIPTION_PUBLIC_BASE_URL'),
    adminPublicHostname: envString(env, 'ADMIN_PUBLIC_HOSTNAME'),
    websocketPath: configuredPath ?? `/${'A'.repeat(43)}`,
  }, 'gateway');
  return {
    gateway: configuredPath === null ? { ...gateway, websocketPath: null } : gateway,
    egressHealthHost: validatePublicDnsHostname(
      envString(env, 'EGRESS_HEALTH_HOST'),
      'EGRESS_HEALTH_HOST',
    ),
  };
}

export function validateSingBoxPath(value) {
  const binaryPath = absolutePath(value, 'SINGBOX_BIN');
  if (path.basename(binaryPath) !== 'sing-box') {
    throw new ValidationError('SINGBOX_BIN', 'must name the sing-box executable');
  }
  return binaryPath;
}
