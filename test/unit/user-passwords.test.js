import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TYPEABLE_SYMBOLS,
  createAdminScryptRecord,
  createUserPassword,
  verifyAdminPassword,
} from '../../src/core/identity/credentials.js';
import { validateState } from '../../src/core/model/state.js';
import { renderSingBoxConfig } from '../../src/core/server/render.js';
import { buildSubscriptionView } from '../../src/core/subscriptions/view.js';
import { setUserPassword } from '../../src/core/users/credential-rotation.js';
import {
  createUser,
  disableUser,
  enableUser,
  findUserBySignInName,
  renameUser,
  revokeUser,
} from '../../src/core/users/lifecycle.js';
import { FIXTURE_TIME, fixtureState, fixtureUser } from '../fixtures/state.js';

const T1 = '2026-09-04T00:01:00.000Z';
const T2 = '2026-09-04T00:02:00.000Z';
const record = await createAdminScryptRecord('correct horse battery staple', {
  randomBytesImpl: () => Buffer.alloc(16, 9),
});
const withPassword = () => fixtureState({ users: [fixtureUser({ password: record })] });

test('generated portal passwords are typeable, high-entropy and accepted by scrypt', async () => {
  assert.equal(new Set(TYPEABLE_SYMBOLS).size, 32);
  assert.doesNotMatch(TYPEABLE_SYMBOLS, /[018l]/u);
  const password = createUserPassword();
  assert.match(password, /^[a-z2-9]{5}(?:-[a-z2-9]{5}){3}$/u);
  assert.ok(Buffer.byteLength(password, 'utf8') >= 12);
  const derived = await createAdminScryptRecord(password);
  assert.equal(await verifyAdminPassword(password, derived), true);
  const fixed = createUserPassword({ randomBytesImpl: () => Buffer.alloc(20, 0) });
  assert.equal(fixed, 'aaaaa-aaaaa-aaaaa-aaaaa');
  assert.throws(() => createUserPassword({ randomBytesImpl: () => Buffer.alloc(19, 0) }), /invalid password/u);
});

test('the password key is optional, exact, and forbidden on revoked tombstones', () => {
  const legacy = validateState(fixtureState());
  assert.equal(Object.hasOwn(legacy.users[0], 'password'), false);
  const modern = validateState(withPassword());
  assert.deepEqual(modern.users[0].password, record);
  for (const [password, path] of [
    ['plain', 'state.users[0].password'],
    [null, 'state.users[0].password'],
    [{ ...record, extra: true }, 'state.users[0].password.extra'],
    [{ ...record, hash: undefined }, 'state.users[0].password.hash'],
  ]) {
    assert.throws(
      () => validateState(fixtureState({ users: [fixtureUser({ password })] })),
      (error) => error.path === path,
    );
  }
  assert.throws(
    () => validateState(fixtureState({
      users: [fixtureUser({ status: 'revoked', revokedAt: FIXTURE_TIME, password: record })],
    })),
    /revoked users cannot retain password material/u,
  );
});

test('password material never reaches the projection or the sing-box configuration', () => {
  const plain = fixtureState();
  const view = JSON.stringify(buildSubscriptionView(withPassword()));
  assert.equal(view, JSON.stringify(buildSubscriptionView(plain)));
  assert.equal(view.includes(record.hash), false);
  const config = JSON.stringify(renderSingBoxConfig(withPassword()));
  assert.equal(config, JSON.stringify(renderSingBoxConfig(plain)));
  assert.equal(config.includes(record.salt), false);
});

test('lifecycle mutations carry the password and revocation strips it', () => {
  const created = createUser(fixtureState(), { id: 'bob', displayName: 'Bob', password: record }, { now: T1 });
  assert.deepEqual(created.user.password, record);
  const bare = createUser(fixtureState(), { id: 'carol', displayName: 'Carol' }, { now: T1 });
  assert.equal(Object.hasOwn(bare.user, 'password'), false);
  assert.throws(
    () => createUser(fixtureState(), { displayName: 'Dan', password: 'plain' }, { now: T1 }),
    (error) => error.path === 'input.password',
  );

  const disabled = disableUser(withPassword(), 'alice', { now: T1 });
  assert.deepEqual(disabled.user.password, record);
  const enabled = enableUser(disabled.state, 'alice', { now: T2 });
  assert.deepEqual(enabled.user.password, record);
  const renamed = renameUser(enabled.state, 'alice', 'Alice Phone', { now: T2 });
  assert.deepEqual(renamed.user.password, record);
  const revoked = revokeUser(renamed.state, 'alice', { now: T2 });
  assert.equal(Object.hasOwn(revoked.user, 'password'), false);
  assert.equal(revoked.user.status, 'revoked');
});

test('setting a password is a revisioned mutation that refuses revoked users', () => {
  const changed = setUserPassword(fixtureState(), 'alice', record, { now: T1 });
  assert.equal(changed.state.revision, 2);
  assert.equal(changed.user.updatedAt, T1);
  assert.deepEqual(changed.user.password, record);
  assert.equal(changed.user.tokenHash, fixtureUser().tokenHash);

  const disabled = disableUser(fixtureState(), 'alice', { now: T1 });
  assert.equal(setUserPassword(disabled.state, 'alice', record, { now: T2 }).user.status, 'disabled');

  const revoked = revokeUser(fixtureState(), 'alice', { now: T1 });
  assert.throws(
    () => setUserPassword(revoked.state, 'alice', record, { now: T2 }),
    (error) => error.code === 'USER_REVOKED',
  );
  assert.throws(() => setUserPassword(fixtureState(), 'alice', 'plain', { now: T1 }), (error) => error.path === 'password');
  assert.throws(() => setUserPassword(fixtureState(), 'nobody', record, { now: T1 }), (error) => error.code === 'USER_NOT_FOUND');
});

test('sign-in names resolve case-insensitively after normalization and skip revoked users', () => {
  const state = fixtureState({
    users: [
      fixtureUser(),
      fixtureUser({
        id: 'jose', displayName: 'José', uuid: '00000000-0000-4000-8000-000000000002',
        tokenHash: `sha256:${'b'.repeat(64)}`,
      }),
      fixtureUser({
        id: 'gone', displayName: 'Gone', uuid: '00000000-0000-4000-8000-000000000003',
        tokenHash: `sha256:${'c'.repeat(64)}`, status: 'revoked', revokedAt: FIXTURE_TIME,
      }),
    ],
  });
  assert.equal(findUserBySignInName(state, 'ALICE')?.id, 'alice');
  assert.equal(findUserBySignInName(state, 'José')?.id, 'jose');
  assert.equal(findUserBySignInName(state, 'josé')?.id, 'jose');
  assert.equal(findUserBySignInName(state, 'Gone'), null);
  assert.equal(findUserBySignInName(state, ' alice'), null);
  assert.equal(findUserBySignInName(state, ''), null);
  assert.equal(findUserBySignInName(state, 42), null);
  assert.equal(findUserBySignInName(state, 'Nobody'), null);
});
