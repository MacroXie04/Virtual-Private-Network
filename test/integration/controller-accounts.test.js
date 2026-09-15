import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { verifyAdminPassword, verifySubscriptionToken } from '../../src/core/identity/credentials.js';
import { deriveExitUuid, exitProfileId } from '../../src/core/identity/exit-profiles.js';
import { renderClientSubscription, renderVlessLinks } from '../../src/core/subscriptions/clients.js';
import { ACCOUNT_MUTATION_BUDGET } from '../../src/control/authority/accounts.js';
import { disableUser, enableUser } from '../../src/core/users/lifecycle.js';
import { fixture, request } from '../fixtures/controller.js';

const PASSWORD_SHAPE = /^[a-z2-9]{5}(?:-[a-z2-9]{5}){3}$/u;

async function administrator(controller) {
  return controller.dispatch(request('admin-login', 'auth.login', { secret: 'correct horse battery staple' }));
}

async function createUser(controller, admin, displayName, expectedRevision, csrf = admin.csrf) {
  return controller.dispatch(request(`create-${displayName}`, 'user.create', {
    sessionId: admin.sessionId, csrf, expectedRevision, displayName,
  }));
}

function signIn(controller, displayName, password, id = `login-${displayName}`) {
  return controller.dispatch(request(id, 'account.login', { displayName, password }));
}

const rejects = (promise, code, status) => assert.rejects(
  promise,
  (error) => error.code === code && error.status === status,
  `expected ${code} ${status}`,
);

test('end users sign in by display name and see only their own connection details', async (t) => {
  const { controller, repository } = await fixture();
  await controller.recover();
  controller.loginFailureDelayMs = 1;
  const admin = await administrator(controller);
  const created = await createUser(controller, admin, 'Alice', 0);
  assert.match(created.rawPassword, PASSWORD_SHAPE);
  const current = await repository.readCurrent();
  assert.equal(JSON.stringify(current.state).includes(created.rawPassword), false);
  assert.equal(Object.hasOwn(current.state.users[0], 'password'), true);
  const adminView = await controller.dispatch(request('admin-view', 'admin.snapshot', { sessionId: admin.sessionId }));
  assert.equal(adminView.users[0].hasPassword, true);
  assert.equal(JSON.stringify(adminView).includes('salt'), false);

  const session = await signIn(controller, 'alice', created.rawPassword);
  assert.match(session.sessionId, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(await controller.dispatch(request('check', 'account.check', { sessionId: session.sessionId })), {});
  const snapshot = await controller.dispatch(request('snap', 'account.snapshot', { sessionId: session.sessionId }));
  assert.deepEqual(Object.keys(snapshot).sort(), ['connections', 'csrf', 'exits', 'gateway', 'ready', 'usage', 'user']);
  assert.deepEqual(snapshot.user, { id: created.user.id, displayName: 'Alice', createdAt: created.user.createdAt });
  assert.deepEqual(snapshot.gateway, { vpnPublicHostname: 'vpn.example.com', publicPort: 443 });
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.usage, null);
  assert.deepEqual(snapshot.exits, []);
  assert.equal(snapshot.connections.length, 1);
  assert.equal(snapshot.connections[0].name, 'Alice');
  assert.equal(snapshot.connections[0].link, created.vlessLink);
  assert.equal(snapshot.csrf, session.csrf);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('tokenHash'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('sha256:'), false);

  for (const format of ['links', 'sing-box', 'clash']) {
    const exported = await controller.dispatch(request(`export-${format}`, 'account.export', {
      sessionId: session.sessionId, format,
    }));
    assert.deepEqual(exported, { format, body: renderClientSubscription(current.state, created.user.id, format) });
  }
  await rejects(controller.dispatch(request('export-mixed', 'account.export', {
    sessionId: session.sessionId, format: 'mixed',
  })), 'INVALID', 400);

  // Realm separation: neither store honours the other's ids, and a raw token is a session in neither.
  await rejects(controller.dispatch(request('x1', 'auth.check', { sessionId: session.sessionId })), 'UNAUTHORIZED', 401);
  await rejects(controller.dispatch(request('x2', 'admin.snapshot', { sessionId: session.sessionId })), 'UNAUTHORIZED', 401);
  await rejects(controller.dispatch(request('x3', 'user.create', {
    sessionId: session.sessionId, csrf: session.csrf, expectedRevision: 1, displayName: 'Mallory',
  })), 'FORBIDDEN', 403);
  await rejects(controller.dispatch(request('x4', 'account.check', { sessionId: admin.sessionId })), 'UNAUTHORIZED', 401);
  await rejects(controller.dispatch(request('x5', 'account.snapshot', { sessionId: admin.sessionId })), 'UNAUTHORIZED', 401);
  await rejects(controller.dispatch(request('x6', 'account.rotateToken', {
    sessionId: admin.sessionId, csrf: admin.csrf,
  })), 'FORBIDDEN', 403);
  await rejects(controller.dispatch(request('x7', 'account.check', { sessionId: created.rawToken })), 'UNAUTHORIZED', 401);
  await rejects(controller.dispatch(request('x8', 'account.login', {
    displayName: 'Alice', password: created.rawPassword, userId: created.user.id,
  })), 'INVALID', 400);
  await rejects(controller.dispatch(request('x9', 'account.login', {
    displayName: 'Alice', password: 'correct horse battery staple',
  })), 'UNAUTHORIZED', 401);

  // Every failure class costs exactly one derivation and yields the same code.
  let derivations = 0;
  controller.verifyPassword = async (password, record) => {
    derivations += 1;
    return verifyAdminPassword(password, record);
  };
  for (const [displayName, password] of [['Nobody', created.rawPassword], ['Alice', 'wrong-password-value'], ['', 'x']]) {
    derivations = 0;
    if (displayName === '') {
      await rejects(signIn(controller, displayName, password, 'login-empty'), 'INVALID', 400);
      continue;
    }
    await rejects(signIn(controller, displayName, password, `fail-${displayName}`), 'UNAUTHORIZED', 401);
    assert.equal(derivations, 1, `${displayName} must pay one derivation`);
  }
  t.diagnostic('realm separation verified in both directions');
});

test('legacy, disabled and revoked users cannot sign in', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  controller.loginFailureDelayMs = 1;
  const admin = await administrator(controller);
  const alice = await createUser(controller, admin, 'Alice', 0);
  const bob = await createUser(controller, admin, 'Bob', 1, alice.csrf);
  const disabled = await controller.dispatch(request('disable-bob', 'user.setStatus', {
    sessionId: admin.sessionId, csrf: bob.csrf, expectedRevision: 2, userId: bob.user.id, status: 'disabled',
  }));
  const carol = await createUser(controller, admin, 'Carol', 3, disabled.csrf);
  await controller.dispatch(request('revoke-carol', 'user.revoke', {
    sessionId: admin.sessionId, csrf: carol.csrf, expectedRevision: 4, userId: carol.user.id, confirmName: 'Carol',
  }));
  // A record written before accounts existed carries no password key at all.
  const current = await repository.readCurrent();
  const timestamp = current.state.updatedAt;
  await controller.transact({
    ...current.state,
    revision: current.state.revision + 1,
    users: [...current.state.users, {
      id: 'legacy', displayName: 'Legacy', uuid: '55555555-5555-4555-8555-555555555555',
      tokenHash: `sha256:${'e'.repeat(64)}`, status: 'active',
      createdAt: timestamp, updatedAt: timestamp, disabledAt: null, revokedAt: null,
    }],
  }, { operation: 'user.create', userId: 'legacy', restart: false });
  assert.equal((await repository.readCurrent()).state.users.length, 4);
  assert.equal(Object.hasOwn((await repository.readCurrent()).state.users[2], 'password'), false);

  let derivations = 0;
  controller.verifyPassword = async (password, record) => {
    derivations += 1;
    return verifyAdminPassword(password, record);
  };
  for (const [displayName, password] of [['Bob', bob.rawPassword], ['Carol', carol.rawPassword], ['Legacy', 'anything-at-all']]) {
    derivations = 0;
    await rejects(signIn(controller, displayName, password), 'UNAUTHORIZED', 401);
    assert.equal(derivations, 1);
  }
  assert.ok(await signIn(controller, 'Alice', alice.rawPassword));
});

test('token rotation and password changes are self-scoped and never restart the data plane', async () => {
  const { controller, repository, runtime, dataDir } = await fixture();
  await controller.recover();
  controller.loginFailureDelayMs = 1;
  const admin = await administrator(controller);
  const alice = await createUser(controller, admin, 'Alice', 0);
  const phone = await signIn(controller, 'Alice', alice.rawPassword, 'phone');
  const laptop = await signIn(controller, 'Alice', alice.rawPassword, 'laptop');
  const restarts = runtime.restarts;

  const rotated = await controller.dispatch(request('rotate', 'account.rotateToken', {
    sessionId: phone.sessionId, csrf: phone.csrf,
  }));
  assert.match(rotated.rawToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(rotated.rawToken, alice.rawToken);
  assert.equal(rotated.subscriptionUrl, `https://admin.example.com/s/${rotated.rawToken}`);
  assert.equal(rotated.user.id, alice.user.id);
  assert.equal(Object.hasOwn(rotated, 'rawPassword'), false);
  let user = (await repository.readCurrent()).state.users[0];
  assert.equal(verifySubscriptionToken(alice.rawToken, user.tokenHash), false);
  assert.equal(verifySubscriptionToken(rotated.rawToken, user.tokenHash), true);
  assert.ok(rotated.vlessLink.startsWith(`vless://${user.uuid}@`));
  assert.ok(alice.vlessLink.startsWith(`vless://${user.uuid}@`), 'the UUID never changes from the portal');
  assert.equal(runtime.restarts, restarts);
  assert.equal(rotated.revision, 2);
  // CSRF rotated on commit: the old value is refused, the new one accepted.
  await rejects(controller.dispatch(request('stale-csrf', 'account.rotateToken', {
    sessionId: phone.sessionId, csrf: phone.csrf,
  })), 'FORBIDDEN', 403);

  await rejects(controller.dispatch(request('wrong-current', 'account.changePassword', {
    sessionId: phone.sessionId, csrf: rotated.csrf, currentPassword: 'not-the-password', newPassword: 'a-brand-new-password',
  })), 'PASSWORD_MISMATCH', 400);
  assert.deepEqual(await controller.dispatch(request('still-here', 'account.check', { sessionId: phone.sessionId })), {});
  await rejects(controller.dispatch(request('too-short', 'account.changePassword', {
    sessionId: phone.sessionId, csrf: rotated.csrf, currentPassword: alice.rawPassword, newPassword: 'short',
  })), 'INVALID', 400);
  await rejects(controller.dispatch(request('unchanged', 'account.changePassword', {
    sessionId: phone.sessionId, csrf: rotated.csrf, currentPassword: alice.rawPassword, newPassword: alice.rawPassword,
  })), 'PASSWORD_UNCHANGED', 400);
  const changed = await controller.dispatch(request('change', 'account.changePassword', {
    sessionId: phone.sessionId, csrf: rotated.csrf, currentPassword: alice.rawPassword, newPassword: 'a-brand-new-password',
  }));
  assert.deepEqual(Object.keys(changed), ['csrf']);
  assert.equal(runtime.restarts, restarts);
  user = (await repository.readCurrent()).state.users[0];
  assert.equal((await repository.readCurrent()).state.revision, 3);
  assert.equal(await verifyAdminPassword('a-brand-new-password', user.password), true);
  assert.equal(await verifyAdminPassword(alice.rawPassword, user.password), false);
  // The changing device stays signed in; every other device must sign in again.
  assert.deepEqual(await controller.dispatch(request('phone-ok', 'account.check', { sessionId: phone.sessionId })), {});
  await rejects(controller.dispatch(request('laptop-out', 'account.check', { sessionId: laptop.sessionId })), 'UNAUTHORIZED', 401);
  await rejects(signIn(controller, 'Alice', alice.rawPassword, 'old-password'), 'UNAUTHORIZED', 401);
  assert.ok(await signIn(controller, 'Alice', 'a-brand-new-password', 'new-password'));

  const auditText = await readFile(path.join(dataDir, 'audit.jsonl'), 'utf8');
  const audit = auditText.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(audit.slice(-2).map(({ operation, userId, outcome }) => ({ operation, userId, outcome })), [
    { operation: 'account.rotate-token', userId: alice.user.id, outcome: 'committed' },
    { operation: 'account.password', userId: alice.user.id, outcome: 'committed' },
  ]);
  for (const secret of ['a-brand-new-password', alice.rawPassword, alice.rawToken, rotated.rawToken]) {
    assert.equal(auditText.includes(secret), false, 'audit lines carry no secret material');
  }

  assert.deepEqual(await controller.dispatch(request('logout', 'account.logout', {
    sessionId: phone.sessionId, csrf: changed.csrf,
  })), {});
  await rejects(controller.dispatch(request('after-logout', 'account.check', { sessionId: phone.sessionId })), 'UNAUTHORIZED', 401);
});

test('administrator resets, disabling, revocation and UUID rotation end portal sessions', async () => {
  const { controller, runtime } = await fixture();
  await controller.recover();
  controller.loginFailureDelayMs = 1;
  const admin = await administrator(controller);
  const alice = await createUser(controller, admin, 'Alice', 0);
  const bob = await createUser(controller, admin, 'Bob', 1, alice.csrf);
  let aliceSession = await signIn(controller, 'Alice', alice.rawPassword, 'alice-1');
  const bobSession = await signIn(controller, 'Bob', bob.rawPassword, 'bob-1');
  const restarts = runtime.restarts;

  const reset = await controller.dispatch(request('reset', 'user.resetPassword', {
    sessionId: admin.sessionId, csrf: bob.csrf, expectedRevision: 2, userId: alice.user.id,
  }));
  assert.match(reset.rawPassword, PASSWORD_SHAPE);
  assert.notEqual(reset.rawPassword, alice.rawPassword);
  assert.deepEqual(Object.keys(reset).sort(), ['csrf', 'rawPassword', 'revision', 'user']);
  assert.equal(reset.user.hasPassword, true);
  assert.equal(reset.revision, 3);
  assert.equal(runtime.restarts, restarts);
  await rejects(controller.dispatch(request('alice-gone', 'account.check', { sessionId: aliceSession.sessionId })), 'UNAUTHORIZED', 401);
  assert.deepEqual(await controller.dispatch(request('bob-stays', 'account.check', { sessionId: bobSession.sessionId })), {});
  await rejects(signIn(controller, 'Alice', alice.rawPassword, 'alice-old'), 'UNAUTHORIZED', 401);
  aliceSession = await signIn(controller, 'Alice', reset.rawPassword, 'alice-2');

  const disabled = await controller.dispatch(request('disable', 'user.setStatus', {
    sessionId: admin.sessionId, csrf: reset.csrf, expectedRevision: 3, userId: alice.user.id, status: 'disabled',
  }));
  await rejects(controller.dispatch(request('alice-disabled', 'account.check', { sessionId: aliceSession.sessionId })), 'UNAUTHORIZED', 401);
  await rejects(signIn(controller, 'Alice', reset.rawPassword, 'alice-while-disabled'), 'UNAUTHORIZED', 401);
  // Provisioning a paused user is allowed so the password is ready when they are enabled.
  const resetWhileDisabled = await controller.dispatch(request('reset-disabled', 'user.resetPassword', {
    sessionId: admin.sessionId, csrf: disabled.csrf, expectedRevision: 4, userId: alice.user.id,
  }));
  const enabled = await controller.dispatch(request('enable', 'user.setStatus', {
    sessionId: admin.sessionId, csrf: resetWhileDisabled.csrf, expectedRevision: 5, userId: alice.user.id, status: 'active',
  }));
  aliceSession = await signIn(controller, 'Alice', resetWhileDisabled.rawPassword, 'alice-3');

  const rotatedAll = await controller.dispatch(request('rotate-all', 'user.rotateCredentials', {
    sessionId: admin.sessionId, csrf: enabled.csrf, expectedRevision: 6, userId: alice.user.id,
  }));
  await rejects(controller.dispatch(request('alice-rotated', 'account.check', { sessionId: aliceSession.sessionId })), 'UNAUTHORIZED', 401);
  aliceSession = await signIn(controller, 'Alice', resetWhileDisabled.rawPassword, 'alice-4');

  const revoked = await controller.dispatch(request('revoke', 'user.revoke', {
    sessionId: admin.sessionId, csrf: rotatedAll.csrf, expectedRevision: 7, userId: alice.user.id, confirmName: 'Alice',
  }));
  await rejects(controller.dispatch(request('alice-revoked', 'account.check', { sessionId: aliceSession.sessionId })), 'UNAUTHORIZED', 401);
  assert.deepEqual(await controller.dispatch(request('bob-still', 'account.check', { sessionId: bobSession.sessionId })), {});
  await rejects(controller.dispatch(request('reset-revoked', 'user.resetPassword', {
    sessionId: admin.sessionId, csrf: revoked.csrf, expectedRevision: 8, userId: alice.user.id,
  })), 'USER_REVOKED', 409);
  await rejects(controller.dispatch(request('reset-unknown', 'user.resetPassword', {
    sessionId: admin.sessionId, csrf: revoked.csrf, expectedRevision: 8, userId: 'nobody-here',
  })), 'USER_NOT_FOUND', 404);
});

test('account mutations respect readiness and roll back without touching sessions', async () => {
  const { controller, runtime, repository } = await fixture();
  await controller.recover();
  controller.loginFailureDelayMs = 1;
  const admin = await administrator(controller);
  const alice = await createUser(controller, admin, 'Alice', 0);
  const session = await signIn(controller, 'Alice', alice.rawPassword);

  controller.ready = false;
  await rejects(controller.dispatch(request('rotate-unready', 'account.rotateToken', {
    sessionId: session.sessionId, csrf: session.csrf,
  })), 'RUNTIME_UNAVAILABLE', 503);
  await rejects(controller.dispatch(request('change-unready', 'account.changePassword', {
    sessionId: session.sessionId, csrf: session.csrf, currentPassword: alice.rawPassword, newPassword: 'another-new-password',
  })), 'RUNTIME_UNAVAILABLE', 503);
  const degraded = await controller.dispatch(request('snapshot-unready', 'account.snapshot', { sessionId: session.sessionId }));
  assert.equal(degraded.ready, false);
  controller.ready = true;

  runtime.failNextProbe = true;
  await rejects(controller.dispatch(request('change-rollback', 'account.changePassword', {
    sessionId: session.sessionId, csrf: session.csrf, currentPassword: alice.rawPassword, newPassword: 'another-new-password',
  })), 'ROLLED_BACK', 503);
  const user = (await repository.readCurrent()).state.users[0];
  assert.equal(await verifyAdminPassword(alice.rawPassword, user.password), true);
  assert.equal((await repository.readCurrent()).state.revision, 1);
  assert.deepEqual(await controller.dispatch(request('still-signed-in', 'account.check', { sessionId: session.sessionId })), {});
  assert.deepEqual(await controller.dispatch(request('logout-degraded', 'account.logout', {
    sessionId: session.sessionId, csrf: session.csrf,
  })), {});
});

test('a live session is re-bound to current state on every data-bearing request', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  controller.loginFailureDelayMs = 1;
  const admin = await administrator(controller);
  const alice = await createUser(controller, admin, 'Alice', 0);
  const mutationOptions = { now: controller.now };

  // A session whose subject never existed passes the in-memory gate only.
  const ghost = controller.accountSessions.issue(1, 'ghost');
  assert.deepEqual(await controller.dispatch(request('ghost-check', 'account.check', { sessionId: ghost.sessionId })), {});
  await rejects(controller.dispatch(request('ghost-snapshot', 'account.snapshot', { sessionId: ghost.sessionId })), 'UNAUTHORIZED', 401);
  assert.equal(controller.accountSessions.get(ghost.sessionId), null);

  let session = await signIn(controller, 'Alice', alice.rawPassword, 'first');
  await rejects(controller.dispatch(request('unknown-op', 'account.frobnicate', {
    sessionId: session.sessionId, csrf: session.csrf,
  })), 'UNKNOWN_OPERATION', 400);

  // A transaction that bypasses the request layer leaves the record in place; the next request evicts it.
  let current = await repository.readCurrent();
  await controller.transact(disableUser(current.state, alice.user.id, mutationOptions).state, {
    operation: 'user.disabled', userId: alice.user.id,
  });
  assert.ok(controller.accountSessions.get(session.sessionId));
  await rejects(controller.dispatch(request('disabled-snapshot', 'account.snapshot', { sessionId: session.sessionId })), 'UNAUTHORIZED', 401);
  assert.equal(controller.accountSessions.get(session.sessionId), null);

  current = await repository.readCurrent();
  await controller.transact(enableUser(current.state, alice.user.id, mutationOptions).state, {
    operation: 'user.active', userId: alice.user.id,
  });
  session = await signIn(controller, 'Alice', alice.rawPassword, 'second');
  current = await repository.readCurrent();
  const { password: _stripped, ...withoutPassword } = current.state.users[0];
  await controller.transact({ ...current.state, revision: current.state.revision + 1, users: [withoutPassword] }, {
    operation: 'user.strip', userId: alice.user.id, restart: false,
  });
  await rejects(controller.dispatch(request('bare-export', 'account.export', {
    sessionId: session.sessionId, format: 'links',
  })), 'UNAUTHORIZED', 401);
  const stale = controller.accountSessions.issue(1, alice.user.id);
  const revision = (await repository.readCurrent()).state.revision;
  await rejects(controller.dispatch(request('bare-rotate', 'account.rotateToken', {
    sessionId: stale.sessionId, csrf: stale.csrf,
  })), 'UNAUTHORIZED', 401);
  assert.equal((await repository.readCurrent()).state.revision, revision);
  assert.equal(controller.accountSessions.get(stale.sessionId), null);
});

test('the sign-in failure delay never holds the shared login tail', async () => {
  const { controller } = await fixture();
  await controller.recover();
  // The delay timer is injected, so the test releases it explicitly instead of racing the clock.
  let release = null;
  controller.setLoginTimeout = (callback, milliseconds) => {
    assert.equal(milliseconds, controller.loginFailureDelayMs);
    release = callback;
    return { unref() {} };
  };
  const admin = await administrator(controller);
  const created = await createUser(controller, admin, 'Alice', 0);

  const before = controller.loginTail;
  let settled = false;
  const failing = signIn(controller, 'Alice', 'wrong-password-value', 'slow-failure')
    .then(() => { throw new Error('unexpected success'); }, (error) => { settled = true; return error; });
  assert.notEqual(controller.loginTail, before);
  const tail = controller.loginTail;
  const session = await signIn(controller, 'Alice', created.rawPassword, 'fast-success');
  assert.ok(session.sessionId, 'a valid sign-in completes while the failure delay is still pending');
  await tail;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the tail is released before the failure delay elapses');
  assert.equal(typeof release, 'function');
  release();
  const error = await failing;
  assert.equal(error.code, 'UNAUTHORIZED');
  assert.equal(settled, true);
});

test('portal changes are budgeted per user across sessions and users hold at most eight sessions', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  controller.loginFailureDelayMs = 1;
  const admin = await administrator(controller);
  const alice = await createUser(controller, admin, 'Alice', 0);
  const bob = await createUser(controller, admin, 'Bob', 1, alice.csrf);
  const phone = await signIn(controller, 'Alice', alice.rawPassword, 'phone');
  const laptop = await signIn(controller, 'Alice', alice.rawPassword, 'laptop');
  const bobSession = await signIn(controller, 'Bob', bob.rawPassword, 'bob');

  let csrf = { phone: phone.csrf, laptop: laptop.csrf };
  for (let index = 0; index < ACCOUNT_MUTATION_BUDGET.limit; index += 1) {
    const device = index % 2 === 0 ? 'phone' : 'laptop';
    const rotated = await controller.dispatch(request(`rotate-${index}`, 'account.rotateToken', {
      sessionId: (device === 'phone' ? phone : laptop).sessionId, csrf: csrf[device],
    }));
    csrf = { ...csrf, [device]: rotated.csrf };
  }
  const revision = (await repository.readCurrent()).state.revision;
  await rejects(controller.dispatch(request('rotate-over', 'account.rotateToken', {
    sessionId: phone.sessionId, csrf: csrf.phone,
  })), 'RATE_LIMITED', 429);
  await rejects(controller.dispatch(request('change-over', 'account.changePassword', {
    sessionId: laptop.sessionId, csrf: csrf.laptop, currentPassword: alice.rawPassword, newPassword: 'another-new-password',
  })), 'RATE_LIMITED', 429);
  assert.equal((await repository.readCurrent()).state.revision, revision, 'a refused change writes nothing');
  assert.deepEqual(await controller.dispatch(request('phone-alive', 'account.check', { sessionId: phone.sessionId })), {});
  // Another user's budget is untouched, and sign-out is never budgeted.
  assert.ok(await controller.dispatch(request('bob-rotate', 'account.rotateToken', {
    sessionId: bobSession.sessionId, csrf: bobSession.csrf,
  })));
  assert.deepEqual(await controller.dispatch(request('laptop-out', 'account.logout', {
    sessionId: laptop.sessionId, csrf: csrf.laptop,
  })), {});

  // The cap is eight per user: the phone goes at the eighth new device, the first device at the ninth.
  const sessions = [];
  for (let index = 0; index < 9; index += 1) {
    sessions.push(await signIn(controller, 'Alice', alice.rawPassword, `device-${index}`));
  }
  await rejects(controller.dispatch(request('phone-evicted', 'account.check', { sessionId: phone.sessionId })), 'UNAUTHORIZED', 401);
  await rejects(controller.dispatch(request('first-evicted', 'account.check', { sessionId: sessions[0].sessionId })), 'UNAUTHORIZED', 401);
  for (const session of sessions.slice(1)) {
    assert.deepEqual(await controller.dispatch(request(`alive-${session.sessionId.slice(0, 6)}`, 'account.check', { sessionId: session.sessionId })), {});
  }
  assert.deepEqual(await controller.dispatch(request('bob-alive', 'account.check', { sessionId: bobSession.sessionId })), {});
});

test('a transaction restarts the data plane whenever the rendered configuration changes', async () => {
  const { controller, repository, runtime } = await fixture();
  await controller.recover();
  const admin = await administrator(controller);
  const alice = await createUser(controller, admin, 'Alice', 0);
  const restarts = runtime.restarts;
  const current = await repository.readCurrent();
  // Removing a user from the inbound changes sing-box.json, so the hint is overridden.
  await controller.transact(disableUser(current.state, alice.user.id, { now: controller.now }).state, {
    operation: 'user.disabled', userId: alice.user.id, restart: false,
  });
  assert.equal(runtime.restarts, restarts + 1);
  // A rename leaves the configuration byte-identical, so the hint stands.
  const renamed = await controller.dispatch(request('rename', 'user.rename', {
    sessionId: admin.sessionId, csrf: alice.csrf, expectedRevision: 2, userId: alice.user.id, displayName: 'Alice Phone',
  }));
  assert.equal(renamed.user.displayName, 'Alice Phone');
  assert.equal(runtime.restarts, restarts + 1);
});

test('the portal lists every published exit next to its own derived credential', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  controller.loginFailureDelayMs = 1;
  const admin = await administrator(controller);
  const alice = await createUser(controller, admin, 'Alice', 0);
  const current = await repository.readCurrent();
  const extraExits = [
    { id: exitProfileId('seoul-device'), name: 'seoul', address: '100.64.0.3', authKey: null },
    { id: exitProfileId('tokyo-device'), name: 'tokyo', address: '100.64.0.4', authKey: null },
  ];
  await controller.transact({
    ...current.state,
    revision: current.state.revision + 1,
    tailscale: { ...current.state.tailscale, extraExits },
  }, { operation: 'exit.add', userId: null });
  const session = await signIn(controller, 'Alice', alice.rawPassword);
  const snapshot = await controller.dispatch(request('exits-snapshot', 'account.snapshot', { sessionId: session.sessionId }));
  const state = (await repository.readCurrent()).state;
  const uuid = state.users[0].uuid;
  assert.deepEqual(snapshot.exits, extraExits.map(({ id, name }) => ({ id, name })));
  assert.deepEqual(snapshot.connections.map((connection) => connection.name), ['Default', 'seoul', 'tokyo']);
  assert.deepEqual(snapshot.connections.map((connection) => connection.link), renderVlessLinks(state, alice.user.id));
  assert.ok(snapshot.connections[0].link.startsWith(`vless://${uuid}@`));
  for (const [index, exit] of extraExits.entries()) {
    assert.ok(snapshot.connections[index + 1].link.startsWith(`vless://${deriveExitUuid(uuid, exit.id)}@`));
  }
});
