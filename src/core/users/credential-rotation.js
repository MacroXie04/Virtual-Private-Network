import { createSubscriptionToken, createUuid, hashSubscriptionToken } from '../identity/credentials.js';
import { validateUuid } from '../validation/values.js';
import {
  beginMutation,
  finishMutation,
  indexForUser,
  replaceAt,
  assertMutable,
  LifecycleError,
} from './mutation-context.js';

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

export const rotateUserToken = rotateSubscriptionToken;
