import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUser,
  disableUser,
  enableUser,
  renameUser,
  revokeUser,
  rotateSubscriptionToken,
  rotateUserCredentials,
  rotateUserUuid,
} from '../../src/lifecycle.js';
import { hashSubscriptionToken, verifySubscriptionToken } from '../../src/credentials.js';
import { fixtureState, fixtureUser } from './core-v2-fixture.js';
import { MAX_REVOKED_USERS, MAX_USER_RECORDS } from '../../src/state-schema.js';

const T1 = '2026-09-04T00:01:00.000Z';
const T2 = '2026-09-04T00:02:00.000Z';
const T3 = '2026-09-04T00:03:00.000Z';
const T4 = '2026-09-04T00:04:00.000Z';

test('creating a user is immutable, revisioned, and returns the raw token only once', () => {
  const original = fixtureState();
  const token = 'b'.repeat(32);
  const result = createUser(original, {
    id: 'bob',
    displayName: 'Bob',
    uuid: '00000000-0000-4000-8000-000000000002',
    token,
  }, { now: T1 });

  assert.equal(original.users.length, 1);
  assert.equal(result.state.revision, 2);
  assert.equal(result.state.updatedAt, T1);
  assert.equal(result.user.status, 'active');
  assert.equal(result.token, token);
  assert.equal(verifySubscriptionToken(token, result.user.tokenHash), true);
  assert.equal(JSON.stringify(result.state).includes(token), false);
  assert.equal(Object.hasOwn(result.user, 'token'), false);
});

test('active, disabled, enabled, and revoked transitions preserve an audit trail', () => {
  const disabled = disableUser(fixtureState(), 'alice', { now: T1 });
  assert.equal(disabled.user.status, 'disabled');
  assert.equal(disabled.user.disabledAt, T1);
  assert.equal(disabled.state.revision, 2);

  const enabled = enableUser(disabled.state, 'alice', { now: T2 });
  assert.equal(enabled.user.status, 'active');
  assert.equal(enabled.user.disabledAt, null);
  assert.equal(enabled.state.revision, 3);

  const renamed = renameUser(enabled.state, 'alice', 'Alice Phone', { now: T3 });
  assert.equal(renamed.user.displayName, 'Alice Phone');

  const revoked = revokeUser(renamed.state, 'alice', { now: T4 });
  assert.equal(revoked.user.status, 'revoked');
  assert.equal(revoked.user.revokedAt, T4);
  assert.throws(() => enableUser(revoked.state, 'alice', { now: T4 }), /only a disabled user/);
  assert.throws(() => renameUser(revoked.state, 'alice', 'Reused', { now: T4 }), /revoked users are immutable/);
});

test('UUID and subscription-token rotation revoke the old credential without leaking the new token', () => {
  const uuidRotation = rotateUserUuid(fixtureState(), 'alice', {
    now: T1,
    uuid: '00000000-0000-4000-8000-000000000055',
  });
  assert.equal(uuidRotation.user.uuid, '00000000-0000-4000-8000-000000000055');

  const token = 'c'.repeat(32);
  const tokenRotation = rotateSubscriptionToken(uuidRotation.state, 'alice', { now: T2, token });
  assert.equal(tokenRotation.token, token);
  assert.equal(verifySubscriptionToken(token, tokenRotation.user.tokenHash), true);
  assert.equal(verifySubscriptionToken('a'.repeat(32), tokenRotation.user.tokenHash), false);
  assert.equal(JSON.stringify(tokenRotation.state).includes(token), false);
});

test('combined credential rotation changes UUID and token in one revision', () => {
  const original = fixtureState();
  const token = 'q'.repeat(32);
  const rotated = rotateUserCredentials(original, 'alice', {
    now: T1,
    uuid: '00000000-0000-4000-8000-000000000099',
    token,
  });
  assert.equal(rotated.state.revision, original.revision + 1);
  assert.equal(rotated.user.uuid, '00000000-0000-4000-8000-000000000099');
  assert.equal(verifySubscriptionToken(token, rotated.user.tokenHash), true);
  assert.equal(verifySubscriptionToken('a'.repeat(32), rotated.user.tokenHash), false);
  assert.equal(JSON.stringify(rotated.state).includes(token), false);

  const disabled = disableUser(original, 'alice', { now: T1 });
  assert.throws(() => rotateSubscriptionToken(disabled.state, 'alice', {
    now: T2,
    token,
  }), /only an active user/u);
  assert.throws(() => rotateUserCredentials(disabled.state, 'alice', {
    now: T2,
    uuid: '00000000-0000-4000-8000-000000000099',
    token,
  }), /only an active user/u);
});

test('lifecycle operations reject duplicate names, duplicate UUIDs, and stale timestamps', () => {
  assert.throws(() => createUser(fixtureState(), {
    id: 'alice-two',
    displayName: 'ALICE',
    uuid: '00000000-0000-4000-8000-000000000002',
    token: 'd'.repeat(32),
  }, { now: T1 }), /display name is already in use/);

  const withBob = createUser(fixtureState(), {
    id: 'bob',
    displayName: 'Bob',
    uuid: '00000000-0000-4000-8000-000000000002',
    token: 'e'.repeat(32),
  }, { now: T1 }).state;
  assert.throws(() => rotateUserUuid(withBob, 'alice', {
    now: T2,
    uuid: '00000000-0000-4000-8000-000000000002',
  }), /UUID is already in use/);

  assert.throws(() => disableUser(fixtureState(), 'alice', {
    now: '2026-09-03T23:59:59.000Z',
  }), /must not precede/);
});

test('revoked tombstones remain auditable without consuming the live-user capacity', () => {
  const users = Array.from({ length: 257 }, (_, index) => fixtureUser({
    id: `user-${index}`,
    displayName: `User ${index}`,
    uuid: `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    tokenHash: hashSubscriptionToken(`token-${index}`.padEnd(32, 'x')),
    ...(index === 256 ? {
      status: 'revoked',
      revokedAt: '2026-09-04T00:00:00.000Z',
    } : {}),
  }));
  const atCapacity = fixtureState({ users });
  assert.throws(() => createUser(atCapacity, {
    id: 'one-too-many',
    displayName: 'One Too Many',
    uuid: '20000000-0000-4000-8000-000000000001',
    token: 'z'.repeat(32),
  }, { now: T1 }), /user limit/);

  const withRoom = revokeUser(atCapacity, 'user-0', { now: T1 }).state;
  const added = createUser(withRoom, {
    id: 'replacement',
    displayName: 'Replacement',
    uuid: '20000000-0000-4000-8000-000000000002',
    token: 'y'.repeat(32),
  }, { now: T2 });
  assert.equal(added.user.status, 'active');
  assert.equal(added.state.users.filter((user) => user.status === 'revoked').length, 2);
});

test('new users compact the oldest revoked tombstones instead of exhausting a long-lived gateway', () => {
  const users = Array.from({ length: MAX_USER_RECORDS }, (_, index) => fixtureUser({
    id: `history-${index}`,
    displayName: `History ${index}`,
    uuid: `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    tokenHash: hashSubscriptionToken(`history-token-${index}`.padEnd(32, 'x')),
    ...(index === MAX_USER_RECORDS - 1 ? {} : {
      status: 'revoked',
      revokedAt: T1,
      updatedAt: T1,
    }),
  }));
  const fullHistory = fixtureState({ users, updatedAt: T1 });
  const added = createUser(fullHistory, {
    id: 'replacement-after-compaction',
    displayName: 'Replacement after compaction',
    uuid: '40000000-0000-4000-8000-000000000001',
    token: 'r'.repeat(32),
  }, { now: T2 });
  assert.equal(added.state.users.filter((user) => user.status === 'revoked').length, MAX_REVOKED_USERS);
  assert.equal(added.state.users.filter((user) => user.status !== 'revoked').length, 2);
  assert.equal(added.state.users.some((user) => user.id === 'history-0'), false);
  assert.equal(added.state.users.some((user) => user.id === `history-${MAX_USER_RECORDS - 2}`), true);
});
