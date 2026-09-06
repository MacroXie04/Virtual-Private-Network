import {
  createSubscriptionToken,
  createUuid,
  hashSubscriptionToken,
} from './credentials.js';
import { MAX_REVOKED_USERS, MAX_USERS, validateState } from './state-schema.js';
import {
  ValidationError,
  normalizeDisplayName,
  validateTimestamp,
  validateUuid,
} from './validation.js';

export class LifecycleError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
    this.status = status;
  }
}

function resolveNow(now = () => new Date()) {
  const value = typeof now === 'function' ? now() : now;
  const timestamp = value instanceof Date ? value.toISOString() : value;
  return validateTimestamp(timestamp, 'now');
}

function beginMutation(value, now) {
  const state = validateState(value);
  const timestamp = resolveNow(now);
  if (timestamp < state.updatedAt) {
    throw new ValidationError('now', 'must not precede the current state timestamp');
  }
  if (state.revision === Number.MAX_SAFE_INTEGER) {
    throw new LifecycleError('REVISION_EXHAUSTED', 'state revision cannot be incremented', 500);
  }
  return { state, timestamp };
}

function finishMutation(state, users, timestamp) {
  return validateState({
    ...state,
    revision: state.revision + 1,
    updatedAt: timestamp,
    users,
  });
}

function indexForUser(state, id) {
  const index = state.users.findIndex((user) => user.id === id);
  if (index < 0) throw new LifecycleError('USER_NOT_FOUND', 'user was not found', 404);
  return index;
}

function replaceAt(users, index, user) {
  return users.map((entry, entryIndex) => (entryIndex === index ? user : entry));
}

function assertMutable(user) {
  if (user.status === 'revoked') {
    throw new LifecycleError('USER_REVOKED', 'revoked users are immutable');
  }
}

function assertAvailableName(state, displayName, exceptId = null) {
  const key = displayName.toLowerCase();
  if (state.users.some((user) => (
    user.id !== exceptId
    && user.status !== 'revoked'
    && user.displayName.toLowerCase() === key
  ))) {
    throw new LifecycleError('DISPLAY_NAME_CONFLICT', 'display name is already in use');
  }
}

function compactRevokedUsers(users) {
  const revoked = users
    .map((user, index) => ({ user, index }))
    .filter(({ user }) => user.status === 'revoked')
    .sort((left, right) => (
      left.user.revokedAt.localeCompare(right.user.revokedAt)
      || left.index - right.index
    ));
  if (revoked.length <= MAX_REVOKED_USERS) return users;
  const retainedIds = new Set(revoked.slice(-MAX_REVOKED_USERS).map(({ user }) => user.id));
  return users.filter((user) => user.status !== 'revoked' || retainedIds.has(user.id));
}

export function getUser(value, id) {
  const state = validateState(value);
  return state.users[indexForUser(state, id)];
}

export function createUser(value, input, {
  now,
  randomUUIDImpl,
  randomBytesImpl,
} = {}) {
  const { state, timestamp } = beginMutation(value, now);
  if (state.users.filter((user) => user.status !== 'revoked').length >= MAX_USERS) {
    throw new LifecycleError('USER_LIMIT_REACHED', 'the user limit has been reached');
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input', 'must be an object');
  }
  const displayName = normalizeDisplayName(input.displayName, 'input.displayName');
  assertAvailableName(state, displayName);
  const id = input.id ?? createUuid({ randomUUIDImpl });
  if (state.users.some((user) => user.id === id)) {
    throw new LifecycleError('USER_ID_CONFLICT', 'user id is already in use');
  }
  const uuid = validateUuid(input.uuid ?? createUuid({ randomUUIDImpl }), 'input.uuid');
  if (state.users.some((user) => user.uuid === uuid)) {
    throw new LifecycleError('UUID_CONFLICT', 'UUID is already in use');
  }
  const token = input.token ?? createSubscriptionToken({ randomBytesImpl });
  const tokenHash = hashSubscriptionToken(token);
  if (state.users.some((user) => user.tokenHash === tokenHash)) {
    throw new LifecycleError('TOKEN_CONFLICT', 'subscription credential is already in use');
  }
  const user = {
    id,
    displayName,
    uuid,
    tokenHash,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    disabledAt: null,
    revokedAt: null,
  };
  const nextState = finishMutation(state, [...compactRevokedUsers(state.users), user], timestamp);
  return {
    state: nextState,
    user: nextState.users.at(-1),
    token,
  };
}

export function renameUser(value, id, displayName, { now } = {}) {
  const { state, timestamp } = beginMutation(value, now);
  const index = indexForUser(state, id);
  const current = state.users[index];
  assertMutable(current);
  const normalized = normalizeDisplayName(displayName, 'displayName');
  assertAvailableName(state, normalized, current.id);
  const user = { ...current, displayName: normalized, updatedAt: timestamp };
  const nextState = finishMutation(state, replaceAt(state.users, index, user), timestamp);
  return { state: nextState, user: nextState.users[index] };
}

export function disableUser(value, id, { now } = {}) {
  const { state, timestamp } = beginMutation(value, now);
  const index = indexForUser(state, id);
  const current = state.users[index];
  if (current.status !== 'active') {
    throw new LifecycleError('INVALID_USER_TRANSITION', 'only an active user can be disabled');
  }
  const user = {
    ...current,
    status: 'disabled',
    updatedAt: timestamp,
    disabledAt: timestamp,
  };
  const nextState = finishMutation(state, replaceAt(state.users, index, user), timestamp);
  return { state: nextState, user: nextState.users[index] };
}

export function enableUser(value, id, { now } = {}) {
  const { state, timestamp } = beginMutation(value, now);
  const index = indexForUser(state, id);
  const current = state.users[index];
  if (current.status !== 'disabled') {
    throw new LifecycleError('INVALID_USER_TRANSITION', 'only a disabled user can be enabled');
  }
  const user = {
    ...current,
    status: 'active',
    updatedAt: timestamp,
    disabledAt: null,
  };
  const nextState = finishMutation(state, replaceAt(state.users, index, user), timestamp);
  return { state: nextState, user: nextState.users[index] };
}

export function revokeUser(value, id, { now } = {}) {
  const { state, timestamp } = beginMutation(value, now);
  const index = indexForUser(state, id);
  const current = state.users[index];
  assertMutable(current);
  const user = {
    ...current,
    status: 'revoked',
    updatedAt: timestamp,
    revokedAt: timestamp,
  };
  const nextState = finishMutation(state, replaceAt(state.users, index, user), timestamp);
  return { state: nextState, user: nextState.users[index] };
}

export function rotateUserUuid(value, id, {
  now,
  uuid,
  randomUUIDImpl,
} = {}) {
  const { state, timestamp } = beginMutation(value, now);
  const index = indexForUser(state, id);
  const current = state.users[index];
  assertMutable(current);
  const nextUuid = validateUuid(uuid ?? createUuid({ randomUUIDImpl }), 'uuid');
  if (nextUuid === current.uuid) {
    throw new LifecycleError('CREDENTIAL_UNCHANGED', 'new UUID must differ from the current UUID');
  }
  if (state.users.some((user) => user.id !== id && user.uuid === nextUuid)) {
    throw new LifecycleError('UUID_CONFLICT', 'UUID is already in use');
  }
  const user = { ...current, uuid: nextUuid, updatedAt: timestamp };
  const nextState = finishMutation(state, replaceAt(state.users, index, user), timestamp);
  return { state: nextState, user: nextState.users[index] };
}

export function rotateSubscriptionToken(value, id, {
  now,
  token,
  randomBytesImpl,
} = {}) {
  const { state, timestamp } = beginMutation(value, now);
  const index = indexForUser(state, id);
  const current = state.users[index];
  if (current.status !== 'active') {
    throw new LifecycleError('INVALID_USER_TRANSITION', 'only an active user can rotate a subscription token');
  }
  const nextToken = token ?? createSubscriptionToken({ randomBytesImpl });
  const tokenHash = hashSubscriptionToken(nextToken);
  if (tokenHash === current.tokenHash) {
    throw new LifecycleError('CREDENTIAL_UNCHANGED', 'new subscription token must differ from the current token');
  }
  if (state.users.some((user) => user.id !== id && user.tokenHash === tokenHash)) {
    throw new LifecycleError('TOKEN_CONFLICT', 'subscription credential is already in use');
  }
  const user = { ...current, tokenHash, updatedAt: timestamp };
  const nextState = finishMutation(state, replaceAt(state.users, index, user), timestamp);
  return { state: nextState, user: nextState.users[index], token: nextToken };
}

/** Atomically replace both client credentials so neither old URL nor old UUID remains usable. */
export function rotateUserCredentials(value, id, {
  now,
  uuid,
  token,
  randomUUIDImpl,
  randomBytesImpl,
} = {}) {
  const { state, timestamp } = beginMutation(value, now);
  const index = indexForUser(state, id);
  const current = state.users[index];
  if (current.status !== 'active') {
    throw new LifecycleError('INVALID_USER_TRANSITION', 'only an active user can rotate credentials');
  }
  const nextUuid = validateUuid(uuid ?? createUuid({ randomUUIDImpl }), 'uuid');
  const nextToken = token ?? createSubscriptionToken({ randomBytesImpl });
  const tokenHash = hashSubscriptionToken(nextToken);
  if (nextUuid === current.uuid || tokenHash === current.tokenHash) {
    throw new LifecycleError('CREDENTIAL_UNCHANGED', 'both new credentials must differ from the current credentials');
  }
  if (state.users.some((user) => user.id !== id && user.uuid === nextUuid)) {
    throw new LifecycleError('UUID_CONFLICT', 'UUID is already in use');
  }
  if (state.users.some((user) => user.id !== id && user.tokenHash === tokenHash)) {
    throw new LifecycleError('TOKEN_CONFLICT', 'subscription credential is already in use');
  }
  const user = {
    ...current,
    uuid: nextUuid,
    tokenHash,
    updatedAt: timestamp,
  };
  const nextState = finishMutation(state, replaceAt(state.users, index, user), timestamp);
  return { state: nextState, user: nextState.users[index], token: nextToken };
}

export const addUser = createUser;
export const rotateUserToken = rotateSubscriptionToken;
