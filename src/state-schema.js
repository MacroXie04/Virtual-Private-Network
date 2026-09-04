import { validateScryptRecord } from './credentials.js';
import {
  ValidationError,
  classifyHost,
  expectExactKeys,
  expectInteger,
  expectNullableString,
  expectString,
  normalizeDisplayName,
  validateAbsoluteStatePath,
  validateHostRecord,
  validateKeyMaterial,
  validatePort,
  validatePublicBaseUrl,
  validateRealityKeyPair,
  validateShortId,
  validateTimestamp,
  validateTokenHash,
  validateUuid,
} from './validation.js';

export const STATE_SCHEMA_VERSION = 2;
export const SUBSCRIPTION_VIEW_SCHEMA_VERSION = 1;
export const MAX_USERS = 256;
export const MAX_USER_RECORDS = 1024;
export const MAX_REVOKED_USERS = 256;
export const HEALTH_USERNAME = 'vpn-health';
export const HEALTH_PASSWORD_BYTES = 32;

const USER_STATUSES = new Set(['active', 'disabled', 'revoked']);

function nullableTimestamp(value, path) {
  return value === null ? null : validateTimestamp(value, path);
}

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

function validateUserId(value, path) {
  const id = expectString(value, path, { min: 3, max: 64 });
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(id)) {
    throw new ValidationError(path, 'must contain only lowercase letters, digits, underscores, and hyphens');
  }
  return id;
}

function validateUser(value, path) {
  const user = expectExactKeys(value, [
    'id',
    'displayName',
    'uuid',
    'tokenHash',
    'status',
    'createdAt',
    'updatedAt',
    'disabledAt',
    'revokedAt',
  ], path);
  const status = expectString(user.status, `${path}.status`, { min: 6, max: 8 });
  if (!USER_STATUSES.has(status)) {
    throw new ValidationError(`${path}.status`, 'must be active, disabled, or revoked');
  }
  const createdAt = validateTimestamp(user.createdAt, `${path}.createdAt`);
  const updatedAt = validateTimestamp(user.updatedAt, `${path}.updatedAt`);
  const disabledAt = nullableTimestamp(user.disabledAt, `${path}.disabledAt`);
  const revokedAt = nullableTimestamp(user.revokedAt, `${path}.revokedAt`);
  if (updatedAt < createdAt) throw new ValidationError(`${path}.updatedAt`, 'must not precede createdAt');
  if (disabledAt !== null && disabledAt < createdAt) {
    throw new ValidationError(`${path}.disabledAt`, 'must not precede createdAt');
  }
  if (disabledAt !== null && disabledAt > updatedAt) {
    throw new ValidationError(`${path}.disabledAt`, 'must not follow updatedAt');
  }
  if (revokedAt !== null && revokedAt < createdAt) {
    throw new ValidationError(`${path}.revokedAt`, 'must not precede createdAt');
  }
  if (revokedAt !== null && revokedAt > updatedAt) {
    throw new ValidationError(`${path}.revokedAt`, 'must not follow updatedAt');
  }
  if (status === 'active' && (disabledAt !== null || revokedAt !== null)) {
    throw new ValidationError(path, 'active users cannot have disabledAt or revokedAt timestamps');
  }
  if (status === 'disabled' && (disabledAt === null || revokedAt !== null)) {
    throw new ValidationError(path, 'disabled users require disabledAt and cannot have revokedAt');
  }
  if (status === 'revoked' && revokedAt === null) {
    throw new ValidationError(path, 'revoked users require revokedAt');
  }
  return {
    id: validateUserId(user.id, `${path}.id`),
    displayName: normalizeDisplayName(user.displayName, `${path}.displayName`),
    uuid: validateUuid(user.uuid, `${path}.uuid`),
    tokenHash: validateTokenHash(user.tokenHash, `${path}.tokenHash`),
    status,
    createdAt,
    updatedAt,
    disabledAt,
    revokedAt,
  };
}

function validateGateway(value, path) {
  const gateway = expectExactKeys(value, [
    'host',
    'advertisedPort',
    'listenPort',
    'publicBaseUrl',
  ], path);
  return {
    host: validateHostRecord(gateway.host, `${path}.host`),
    advertisedPort: validatePort(gateway.advertisedPort, `${path}.advertisedPort`),
    listenPort: validatePort(gateway.listenPort, `${path}.listenPort`),
    publicBaseUrl: validatePublicBaseUrl(gateway.publicBaseUrl, `${path}.publicBaseUrl`),
  };
}

function validateReality(value, path, { publicOnly = false } = {}) {
  const keys = publicOnly
    ? ['serverName', 'publicKey', 'shortId']
    : ['serverName', 'privateKey', 'publicKey', 'shortId'];
  const reality = expectExactKeys(value, keys, path);
  const result = {
    serverName: normalizeDnsName(reality.serverName, `${path}.serverName`),
    publicKey: validateKeyMaterial(reality.publicKey, `${path}.publicKey`),
    shortId: validateShortId(reality.shortId, `${path}.shortId`),
  };
  if (!publicOnly) {
    const pair = validateRealityKeyPair(reality.privateKey, result.publicKey, {
      privatePath: `${path}.privateKey`,
      publicPath: `${path}.publicKey`,
    });
    return {
      serverName: result.serverName,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      shortId: result.shortId,
    };
  }
  return result;
}

function validateTailscale(value, path) {
  const tailscale = expectExactKeys(value, [
    'hostname',
    'stateDirectory',
    'authKey',
    'apiKey',
    'exitNode',
  ], path);
  return {
    hostname: normalizeDnsName(tailscale.hostname, `${path}.hostname`),
    stateDirectory: validateAbsoluteStatePath(tailscale.stateDirectory, `${path}.stateDirectory`),
    authKey: nullableSecret(tailscale.authKey, `${path}.authKey`),
    apiKey: nullableSecret(tailscale.apiKey, `${path}.apiKey`),
    exitNode: normalizeConnectHost(tailscale.exitNode, `${path}.exitNode`),
  };
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
      host: normalizeConnectHost(target.host, `${path}.target.host`),
      port: validatePort(target.port, `${path}.target.port`),
    },
  };
}

function validateAdmin(value, path) {
  const admin = expectExactKeys(value, ['scrypt'], path);
  return { scrypt: validateScryptRecord(admin.scrypt, `${path}.scrypt`) };
}

function assertUniqueUsers(users) {
  const properties = [
    ['id', (user) => user.id],
    ['uuid', (user) => user.uuid],
    ['tokenHash', (user) => user.tokenHash],
  ];
  for (const [name, getter] of properties) {
    const seen = new Set();
    users.forEach((user, index) => {
      const value = getter(user);
      if (seen.has(value)) throw new ValidationError(`state.users[${index}].${name}`, 'must be unique');
      seen.add(value);
    });
  }
  const activeNames = new Set();
  users.forEach((user, index) => {
    if (user.status === 'revoked') return;
    const key = user.displayName.toLowerCase();
    if (activeNames.has(key)) {
      throw new ValidationError(`state.users[${index}].displayName`, 'must be unique among non-revoked users');
    }
    activeNames.add(key);
  });
}

function validateStateWithOptions(value, { allowLegacyHealthTarget = false } = {}) {
  const state = expectExactKeys(value, [
    'schemaVersion',
    'revision',
    'createdAt',
    'updatedAt',
    'gateway',
    'reality',
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
    reality: validateReality(state.reality, 'state.reality'),
    tailscale: validateTailscale(state.tailscale, 'state.tailscale'),
    health: validateHealth(state.health, 'state.health'),
    admin: validateAdmin(state.admin, 'state.admin'),
    users,
  };
  if (normalized.gateway.listenPort === normalized.health.listenPort) {
    throw new ValidationError('state.health.listenPort', 'must differ from gateway.listenPort');
  }
  if (!allowLegacyHealthTarget && (
    normalized.health.target.host !== normalized.reality.serverName
    || normalized.health.target.port !== 443
  )) {
    throw new ValidationError(
      'state.health.target',
      'must probe the REALITY server name on port 443 so readiness covers exit-routed DNS and TCP',
    );
  }
  return normalized;
}

export function validateState(value) {
  return validateStateWithOptions(value);
}

/**
 * Read-only compatibility parser for the short-lived schema-v2 policy that
 * allowed an arbitrary readiness target. Writers must always use
 * `validateState`; bootstrap upgrades this shape before any service starts.
 */
export function validateStoredState(value) {
  return validateStateWithOptions(value, { allowLegacyHealthTarget: true });
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

function validateProjectedUser(value, path) {
  const user = expectExactKeys(value, ['id', 'displayName', 'uuid', 'tokenHash'], path);
  return {
    id: validateUserId(user.id, `${path}.id`),
    displayName: normalizeDisplayName(user.displayName, `${path}.displayName`),
    uuid: validateUuid(user.uuid, `${path}.uuid`),
    tokenHash: validateTokenHash(user.tokenHash, `${path}.tokenHash`),
  };
}

export function validateSubscriptionView(value) {
  const view = expectExactKeys(value, [
    'schemaVersion',
    'revision',
    'gateway',
    'reality',
    'users',
  ], 'subscriptionView');
  if (view.schemaVersion !== SUBSCRIPTION_VIEW_SCHEMA_VERSION) {
    throw new ValidationError('subscriptionView.schemaVersion', `must be ${SUBSCRIPTION_VIEW_SCHEMA_VERSION}`);
  }
  const gateway = expectExactKeys(view.gateway, ['host', 'advertisedPort'], 'subscriptionView.gateway');
  if (!Array.isArray(view.users)) throw new ValidationError('subscriptionView.users', 'must be an array');
  if (view.users.length > MAX_USERS) {
    throw new ValidationError('subscriptionView.users', `must contain at most ${MAX_USERS} active users`);
  }
  const users = view.users.map((user, index) => validateProjectedUser(user, `subscriptionView.users[${index}]`));
  assertUniqueUsers(users.map((user) => ({ ...user, status: 'active' })));
  return {
    schemaVersion: SUBSCRIPTION_VIEW_SCHEMA_VERSION,
    revision: expectInteger(view.revision, 'subscriptionView.revision', { min: 0 }),
    gateway: {
      host: validateHostRecord(gateway.host, 'subscriptionView.gateway.host'),
      advertisedPort: validatePort(gateway.advertisedPort, 'subscriptionView.gateway.advertisedPort'),
    },
    reality: validateReality(view.reality, 'subscriptionView.reality', { publicOnly: true }),
    users,
  };
}

export const parseState = validateState;
export const parseSubscriptionView = validateSubscriptionView;
