import { assertUniqueUsers, validateUser } from '../users/records.js';
import {
  ValidationError,
  expectExactKeys,
  expectInteger,
  expectString,
  validateTimestamp,
} from '../validation/values.js';
import { STATE_SCHEMA_VERSION, MAX_USERS, MAX_USER_RECORDS, VLESS_LISTEN_PORT } from './policy.js';
import { validateGateway, validateTailscale, validateHealth, validateAdmin } from './settings.js';

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
