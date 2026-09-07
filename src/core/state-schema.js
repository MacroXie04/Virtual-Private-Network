import { validateScryptRecord } from './credentials.js';
import { MAX_EXTRA_EXITS, validateExitAddress, validateExitProfileId } from './exit-profiles.js';
import { assertUniqueUsers, validateUser } from './user-records.js';
import {
  ValidationError,
  classifyHost,
  expectExactKeys,
  expectInteger,
  expectNullableString,
  expectString,
  validateAbsoluteStatePath,
  validatePort,
  validatePublicDnsHostname,
  validatePublicIngressSettings,
  validateTimestamp,
} from './validation.js';

export const STATE_SCHEMA_VERSION = 3;
export const SUBSCRIPTION_VIEW_SCHEMA_VERSION = 2;
export const MAX_USERS = 256;
export const MAX_USER_RECORDS = 1024;
export const MAX_REVOKED_USERS = 256;
export const HEALTH_USERNAME = 'vpn-health';
export const HEALTH_PASSWORD_BYTES = 32;
export const VLESS_LISTEN_HOST = '127.0.0.1';
export const VLESS_LISTEN_PORT = 8443;
export const PUBLIC_VLESS_PORT = 443;
export { MAX_EXTRA_EXITS } from './exit-profiles.js';

function nullableSecret(value, path) {
  const secret = expectNullableString(value, path, { min: 8, max: 512 });
  if (secret !== null && secret !== secret.trim()) {
    throw new ValidationError(path, 'must not contain surrounding whitespace');
  }
  return secret;
}

function normalizeDnsName(value, path) {
  const host = classifyHost(value, path);
  if (host.kind !== 'dns') throw new ValidationError(path, 'must be a DNS name');
  return host.value;
}

function normalizeConnectHost(value, path) {
  return classifyHost(value, path).value;
}

function validateGateway(value, path) {
  return validatePublicIngressSettings(value, path);
}

function validateTailscale(value, path) {
  const tailscale = expectExactKeys(value, [
    'hostname',
    'stateDirectory',
    'authKey',
    'apiKey',
    'exitNode',
    ...(Object.hasOwn(value ?? {}, 'extraExits') ? ['extraExits'] : []),
  ], path);
  const normalized = {
    hostname: normalizeDnsName(tailscale.hostname, `${path}.hostname`),
    stateDirectory: validateAbsoluteStatePath(tailscale.stateDirectory, `${path}.stateDirectory`),
    authKey: nullableSecret(tailscale.authKey, `${path}.authKey`),
    apiKey: nullableSecret(tailscale.apiKey, `${path}.apiKey`),
    exitNode: normalizeConnectHost(tailscale.exitNode, `${path}.exitNode`),
  };
  if (Object.hasOwn(tailscale, 'extraExits')) {
    normalized.extraExits = validateExtraExits(tailscale.extraExits, `${path}.extraExits`);
  }
  return normalized;
}

export function validateExtraExits(value, path, projected = false) {
  if (!Array.isArray(value) || value.length > MAX_EXTRA_EXITS) {
    throw new ValidationError(path, `must be an array of at most ${MAX_EXTRA_EXITS} extra exits`);
  }
  const ids = new Set();
  const names = new Set();
  const addresses = new Set();
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const exit = expectExactKeys(entry, projected
      ? ['id', 'name']
      : ['id', 'name', 'address', 'authKey'], entryPath);
    const normalized = {
      id: validateExitProfileId(exit.id, `${entryPath}.id`),
      name: normalizeDnsName(exit.name, `${entryPath}.name`),
    };
    if (ids.has(normalized.id)) throw new ValidationError(`${entryPath}.id`, 'must be unique');
    if (names.has(normalized.name)) throw new ValidationError(`${entryPath}.name`, 'must be unique');
    ids.add(normalized.id);
    names.add(normalized.name);
    if (!projected) {
      normalized.address = validateExitAddress(exit.address, `${entryPath}.address`);
      normalized.authKey = nullableSecret(exit.authKey, `${entryPath}.authKey`);
      if (addresses.has(normalized.address)) {
        throw new ValidationError(`${entryPath}.address`, 'must be unique');
      }
      addresses.add(normalized.address);
    }
    return normalized;
  });
}

function validateHealth(value, path) {
  const health = expectExactKeys(value, ['listenPort', 'username', 'password', 'target'], path);
  const target = expectExactKeys(health.target, ['host', 'port'], `${path}.target`);
  const username = expectString(health.username, `${path}.username`, {
    min: HEALTH_USERNAME.length,
    max: HEALTH_USERNAME.length,
  });
  if (username !== HEALTH_USERNAME) {
    throw new ValidationError(`${path}.username`, `must be ${HEALTH_USERNAME}`);
  }
  const password = expectString(health.password, `${path}.password`, { min: 43, max: 43 });
  if (!/^[A-Za-z0-9_-]{43}$/u.test(password)) {
    throw new ValidationError(`${path}.password`, 'must be a canonical 256-bit base64url secret');
  }
  const decodedPassword = Buffer.from(password, 'base64url');
  if (
    decodedPassword.length !== HEALTH_PASSWORD_BYTES
    || decodedPassword.toString('base64url') !== password
  ) {
    throw new ValidationError(`${path}.password`, 'must be a canonical 256-bit base64url secret');
  }
  return {
    listenPort: validatePort(health.listenPort, `${path}.listenPort`),
    username,
    password,
    target: {
      host: validatePublicDnsHostname(target.host, `${path}.target.host`),
      port: validatePort(target.port, `${path}.target.port`),
    },
  };
}

function validateAdmin(value, path) {
  const admin = expectExactKeys(value, ['scrypt'], path);
  return { scrypt: validateScryptRecord(admin.scrypt, `${path}.scrypt`) };
}

function validateStateWithOptions(value) {
  const state = expectExactKeys(value, [
    'schemaVersion',
    'revision',
    'createdAt',
    'updatedAt',
    'gateway',
    'tailscale',
    'health',
    'admin',
    'users',
  ], 'state');
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new ValidationError('state.schemaVersion', `must be ${STATE_SCHEMA_VERSION}`);
  }
  const revision = expectInteger(state.revision, 'state.revision', { min: 0 });
  const createdAt = validateTimestamp(state.createdAt, 'state.createdAt');
  const updatedAt = validateTimestamp(state.updatedAt, 'state.updatedAt');
  if (updatedAt < createdAt) throw new ValidationError('state.updatedAt', 'must not precede createdAt');
  if (!Array.isArray(state.users)) throw new ValidationError('state.users', 'must be an array');
  if (state.users.length > MAX_USER_RECORDS) {
    throw new ValidationError('state.users', `must contain at most ${MAX_USER_RECORDS} audit records`);
  }
  const users = state.users.map((user, index) => validateUser(user, `state.users[${index}]`));
  if (users.filter((user) => user.status !== 'revoked').length > MAX_USERS) {
    throw new ValidationError('state.users', `must contain at most ${MAX_USERS} non-revoked users`);
  }
  users.forEach((user, index) => {
    if (user.createdAt < createdAt) {
      throw new ValidationError(`state.users[${index}].createdAt`, 'must not precede state.createdAt');
    }
    if (user.updatedAt > updatedAt) {
      throw new ValidationError(`state.users[${index}].updatedAt`, 'must not follow state.updatedAt');
    }
  });
  assertUniqueUsers(users);
  const normalized = {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision,
    createdAt,
    updatedAt,
    gateway: validateGateway(state.gateway, 'state.gateway'),
    tailscale: validateTailscale(state.tailscale, 'state.tailscale'),
    health: validateHealth(state.health, 'state.health'),
    admin: validateAdmin(state.admin, 'state.admin'),
    users,
  };
  if (normalized.health.listenPort === VLESS_LISTEN_PORT) {
    throw new ValidationError('state.health.listenPort', `must differ from ${VLESS_LISTEN_PORT}`);
  }
  const subscriptionHostname = new URL(normalized.gateway.subscriptionPublicBaseUrl).hostname;
  if (
    normalized.health.target.port !== 443
    || [
      normalized.gateway.vpnPublicHostname,
      subscriptionHostname,
      normalized.gateway.adminPublicHostname,
    ].includes(normalized.health.target.host)
  ) {
    throw new ValidationError(
      'state.health.target',
      'must use an independent public DNS hostname on port 443',
    );
  }
  return normalized;
}

export function validateState(value) {
  return validateStateWithOptions(value);
}

export function parseStateJson(text) {
  let value;
  try {
    value = JSON.parse(expectString(text, 'stateJson', { min: 2, max: 1024 * 1024, controls: true }));
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('stateJson', 'must contain valid JSON');
  }
  return validateState(value);
}

export const parseState = validateState;
