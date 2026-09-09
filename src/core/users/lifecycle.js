import { createSubscriptionToken, createUuid, hashSubscriptionToken } from '../identity/credentials.js';
import { MAX_USERS } from '../model/policy.js';
import { validateState } from '../model/state.js';
import { ValidationError, normalizeDisplayName, validateUuid } from '../validation/values.js';
import {
  beginMutation,
  finishMutation,
  indexForUser,
  replaceAt,
  assertMutable,
  assertAvailableName,
  compactRevokedUsers,
  LifecycleError,
} from './mutation-context.js';

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

export const addUser = createUser;
