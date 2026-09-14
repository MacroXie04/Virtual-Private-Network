import { MAX_REVOKED_USERS } from '../model/policy.js';
import { validateState } from '../model/state.js';
import { ValidationError, validateTimestamp } from '../validation/values.js';

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

export function beginMutation(value, now) {
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

export function finishMutation(state, users, timestamp) {
  return validateState({
    ...state,
    revision: state.revision + 1,
    updatedAt: timestamp,
    users,
  });
}

export function indexForUser(state, id) {
  const index = state.users.findIndex((user) => user.id === id);
  if (index < 0) throw new LifecycleError('USER_NOT_FOUND', 'user was not found', 404);
  return index;
}

export function replaceAt(users, index, user) {
  return users.map((entry, entryIndex) => (entryIndex === index ? user : entry));
}

export function assertMutable(user) {
  if (user.status === 'revoked') {
    throw new LifecycleError('USER_REVOKED', 'revoked users are immutable');
  }
}

export function assertAvailableName(state, displayName, exceptId = null) {
  const key = displayName.toLowerCase();
  if (state.users.some((user) => (
    user.id !== exceptId
    && user.status !== 'revoked'
    && user.displayName.toLowerCase() === key
  ))) {
    throw new LifecycleError('DISPLAY_NAME_CONFLICT', 'display name is already in use');
  }
}

export function compactRevokedUsers(users) {
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
