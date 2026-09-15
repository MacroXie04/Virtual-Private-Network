import assert from 'node:assert/strict';

import path from 'node:path';
import test from 'node:test';
import { verifySubscriptionToken } from '../../src/core/identity/credentials.js';
import { UsageTracker } from '../../src/control/authority/usage.js';
import { fixture, request } from '../fixtures/controller.js';

test('controller login, create, disable, enable, and revoke are isolated and transactional', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  const login = await controller.dispatch(request('login-1', 'auth.login', {
    secret: 'correct horse battery staple',
  }));
  assert.deepEqual(await controller.dispatch(request('check-1', 'auth.check', {
    sessionId: login.sessionId,
  })), {});
  const created = await controller.dispatch(request('create-1', 'user.create', {
    sessionId: login.sessionId,
    csrf: login.csrf,
    expectedRevision: 0,
    displayName: 'Alice: #1',
  }));
  assert.equal(created.user.status, 'active');
  assert.match(created.rawToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(created.subscriptionUrl, `https://admin.example.com/s/${created.rawToken}`);
  assert.ok(created.vlessLink.startsWith('vless://'));
  assert.match(created.rawPassword, /^[a-z2-9]{5}(?:-[a-z2-9]{5}){3}$/u);
  await assert.rejects(controller.dispatch(request('token-is-not-account', 'account.check', {
    sessionId: created.rawToken,
  })), (error) => error.code === 'UNAUTHORIZED' && error.status === 401);
  await assert.rejects(controller.dispatch(request('token-is-not-admin', 'admin.snapshot', {
    sessionId: created.rawToken,
  })), (error) => error.code === 'UNAUTHORIZED' && error.status === 401);
  await assert.rejects(controller.dispatch(request('token-is-not-auth-check', 'auth.check', {
    sessionId: created.rawToken,
  })), (error) => error.code === 'UNAUTHORIZED' && error.status === 401);

  let current = await repository.readCurrent();
  assert.equal(current.state.users.length, 1);
  assert.equal(JSON.stringify(current.state).includes(created.rawToken), false);
  assert.equal(JSON.stringify(current.state).includes(created.rawPassword), false);
  assert.equal(current.subscriptionView.users.length, 1);
  assert.equal(current.config.inbounds[0].users.length, 1);
  assert.equal(current.state.gateway.subscriptionPublicBaseUrl, 'https://subscriptions.example.com');
  assert.equal(current.subscriptionView.gateway.subscriptionPublicHostname, 'subscriptions.example.com');

  const disabled = await controller.dispatch(request('disable-1', 'user.setStatus', {
    sessionId: login.sessionId,
    csrf: created.csrf,
    expectedRevision: 1,
    userId: created.user.id,
    status: 'disabled',
  }));
  current = await repository.readCurrent();
  assert.equal(current.subscriptionView.users.length, 0);
  assert.equal(current.config.inbounds[0].users.length, 0);

  const enabled = await controller.dispatch(request('enable-1', 'user.setStatus', {
    sessionId: login.sessionId,
    csrf: disabled.csrf,
    expectedRevision: 2,
    userId: created.user.id,
    status: 'active',
  }));
  const revoked = await controller.dispatch(request('revoke-1', 'user.revoke', {
    sessionId: login.sessionId,
    csrf: enabled.csrf,
    expectedRevision: 3,
    userId: created.user.id,
    confirmName: 'Alice: #1',
  }));
  assert.equal(revoked.user.status, 'revoked');
  current = await repository.readCurrent();
  assert.equal(current.subscriptionView.users.length, 0);
  await assert.rejects(controller.dispatch(request('export-1', 'user.export', {
    sessionId: login.sessionId,
    userId: created.user.id,
  })), (error) => error.code === 'USER_NOT_FOUND' && error.status === 404);
});

test('snapshots use the administration origin while historical public-base settings remain readable', async () => {
  const { controller, repository, runtime } = await fixture();
  await controller.recover();
  const session = controller.sessions.issue();
  const before = await repository.readCurrent();
  const snapshot = await controller.dispatch(request('unified-snapshot', 'admin.snapshot', {
    sessionId: session.sessionId,
  }));
  assert.equal(snapshot.gateway.subscriptionPublicBaseUrl, 'https://admin.example.com');
  assert.equal((await repository.readCurrent()).id, before.id);
  const restarts = runtime.restarts;
  await controller.dispatch(request('maintain-old-subscription-origin', 'publicBase.set', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: before.state.revision,
    url: 'https://old-subscriptions.example.com',
  }));
  const current = await repository.readCurrent();
  assert.equal(current.state.gateway.subscriptionPublicBaseUrl, 'https://old-subscriptions.example.com');
  assert.equal(current.subscriptionView.gateway.subscriptionPublicHostname, 'old-subscriptions.example.com');
  assert.deepEqual((await repository.readRevision(before.id)).subscriptionView, before.subscriptionView);
  const updated = await controller.dispatch(request('unified-snapshot-after-update', 'admin.snapshot', {
    sessionId: session.sessionId,
  }));
  assert.equal(updated.gateway.subscriptionPublicBaseUrl, 'https://admin.example.com');
  assert.equal(runtime.restarts, restarts);
});

test('combined credential rotation invalidates both the previous UUID and subscription token atomically', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  const session = controller.sessions.issue();
  const created = await controller.dispatch(request('create-for-rotation', 'user.create', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    displayName: 'Rotating user',
  }));
  const oldUuid = (await repository.readCurrent()).state.users[0].uuid;
  const rotated = await controller.dispatch(request('rotate-all', 'user.rotateCredentials', {
    sessionId: session.sessionId,
    csrf: created.csrf,
    expectedRevision: 1,
    userId: created.user.id,
  }));

  const current = await repository.readCurrent();
  const user = current.state.users[0];
  const inboundUser = current.config.inbounds
    .find((inbound) => inbound.tag === 'vless-in').users[0];
  assert.notEqual(user.uuid, oldUuid);
  assert.equal(inboundUser.uuid, user.uuid);
  assert.equal(JSON.stringify(current.config).includes(oldUuid), false);
  assert.equal(verifySubscriptionToken(created.rawToken, user.tokenHash), false);
  assert.equal(verifySubscriptionToken(rotated.rawToken, user.tokenHash), true);
  assert.equal(rotated.subscriptionUrl, `https://admin.example.com/s/${rotated.rawToken}`);
  assert.ok(rotated.vlessLink.startsWith(`vless://${user.uuid}@`));
  assert.equal(current.state.revision, 2);
});

test('an exact credential request replay returns the same one-time result without a second commit', async () => {
  const { controller, repository, runtime } = await fixture();
  await controller.recover();
  const session = controller.sessions.issue();
  const createRequest = request('credential-operation-1', 'user.create', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    displayName: 'Recoverable delivery',
  });
  const created = await controller.dispatch(createRequest);
  const restartsAfterCommit = runtime.restarts;
  const replayed = await controller.dispatch(structuredClone(createRequest));
  assert.deepEqual(replayed, created);
  assert.equal((await repository.readCurrent()).state.revision, 1);
  assert.equal(runtime.restarts, restartsAfterCommit);

  await assert.rejects(controller.dispatch({
    ...createRequest,
    displayName: 'Changed request',
  }), (error) => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409);
});

test('credential replay survives unrelated commits but never returns superseded credentials', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  const sessionA = controller.sessions.issue();
  const sessionB = controller.sessions.issue();
  const createRequest = request('credential-operation-a', 'user.create', {
    sessionId: sessionA.sessionId,
    csrf: sessionA.csrf,
    expectedRevision: 0,
    displayName: 'Lost response user',
  });
  const createdA = await controller.dispatch(createRequest);
  const createdB = await controller.dispatch(request('credential-operation-b', 'user.create', {
    sessionId: sessionB.sessionId,
    csrf: sessionB.csrf,
    expectedRevision: 1,
    displayName: 'Unrelated administrator change',
  }));

  const replayed = await controller.dispatch(structuredClone(createRequest));
  assert.equal(replayed.rawToken, createdA.rawToken);
  assert.equal(replayed.vlessLink, createdA.vlessLink);
  assert.equal(replayed.subscriptionUrl, createdA.subscriptionUrl);
  assert.equal(replayed.revision, 2);
  assert.equal((await repository.readCurrent()).state.users.length, 2);

  await controller.dispatch(request('supersede-a', 'user.rotateToken', {
    sessionId: sessionB.sessionId,
    csrf: createdB.csrf,
    expectedRevision: 2,
    userId: createdA.user.id,
  }));
  await assert.rejects(
    controller.dispatch(structuredClone(createRequest)),
    (error) => error.code === 'IDEMPOTENCY_STALE' && error.status === 409,
  );
});

test('renaming a user updates subscriptions without restarting the data plane and rejects conflicts', async () => {
  const { controller, repository, runtime } = await fixture();
  await controller.recover();
  const session = controller.sessions.issue();
  const alice = await controller.dispatch(request('create-alice', 'user.create', {
    sessionId: session.sessionId, csrf: session.csrf, expectedRevision: 0, displayName: 'Alice',
  }));
  const bob = await controller.dispatch(request('create-bob', 'user.create', {
    sessionId: session.sessionId, csrf: alice.csrf, expectedRevision: 1, displayName: 'Bob',
  }));
  const restarts = runtime.restarts;
  const renamed = await controller.dispatch(request('rename-1', 'user.rename', {
    sessionId: session.sessionId, csrf: bob.csrf, expectedRevision: 2, userId: alice.user.id, displayName: 'Alice Phone',
  }));
  assert.equal(renamed.user.displayName, 'Alice Phone');
  assert.equal(renamed.revision, 3);
  const current = await repository.readCurrent();
  assert.equal(current.state.users[0].displayName, 'Alice Phone');
  assert.equal(current.subscriptionView.users[0].displayName, 'Alice Phone');
  assert.equal(runtime.restarts, restarts);

  await assert.rejects(controller.dispatch(request('rename-conflict', 'user.rename', {
    sessionId: session.sessionId, csrf: renamed.csrf, expectedRevision: 3, userId: alice.user.id, displayName: 'bob',
  })), (error) => error.code === 'DISPLAY_NAME_CONFLICT' && error.status === 409);
  await assert.rejects(controller.dispatch(request('rename-invalid', 'user.rename', {
    sessionId: session.sessionId, csrf: renamed.csrf, expectedRevision: 3, userId: alice.user.id, displayName: ' padded ',
  })), (error) => error.code === 'INVALID' && error.status === 400);
  assert.equal((await repository.readCurrent()).state.revision, 3);

  const revoked = await controller.dispatch(request('revoke-bob', 'user.revoke', {
    sessionId: session.sessionId, csrf: renamed.csrf, expectedRevision: 3, userId: bob.user.id, confirmName: 'Bob',
  }));
  await assert.rejects(controller.dispatch(request('rename-revoked', 'user.rename', {
    sessionId: session.sessionId, csrf: revoked.csrf, expectedRevision: 4, userId: bob.user.id, displayName: 'Robert',
  })), (error) => error.code === 'USER_REVOKED' && error.status === 409);
});

test('snapshots carry persisted per-user usage sampled before every data-plane restart', async () => {
  const { controller, repository, runtime, dataDir } = await fixture();
  let counters = [];
  const tracker = new UsageTracker({ path: path.join(dataDir, 'usage.json'), query: async () => counters });
  controller.usage = tracker;
  await controller.recover();
  const session = controller.sessions.issue();
  const alice = await controller.dispatch(request('usage-create', 'user.create', {
    sessionId: session.sessionId, csrf: session.csrf, expectedRevision: 0, displayName: 'Alice',
  }));
  counters = [
    { name: `user>>>${alice.user.id}>>>traffic>>>uplink`, value: 2048 },
    { name: `user>>>${alice.user.id}>>>traffic>>>downlink`, value: 4096 },
  ];
  assert.equal(await controller.collectUsage(), true);
  let snapshot = await controller.dispatch(request('usage-snapshot', 'admin.snapshot', { sessionId: session.sessionId }));
  assert.equal(snapshot.users[0].usage.uplinkBytes, 2048);
  assert.equal(snapshot.users[0].usage.downlinkBytes, 4096);
  assert.match(snapshot.users[0].usage.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);

  // Disabling restarts sing-box: the deltas accrued since the last sample are
  // folded first, then the counters are known to start again from zero.
  counters = [
    { name: `user>>>${alice.user.id}>>>traffic>>>uplink`, value: 3000 },
    { name: `user>>>${alice.user.id}>>>traffic>>>downlink`, value: 4096 },
  ];
  const restarts = runtime.restarts;
  await controller.dispatch(request('usage-disable', 'user.setStatus', {
    sessionId: session.sessionId, csrf: alice.csrf, expectedRevision: 1, userId: alice.user.id, status: 'disabled',
  }));
  assert.equal(runtime.restarts, restarts + 1);
  assert.equal(tracker.counters.size, 0);
  counters = [{ name: `user>>>${alice.user.id}>>>traffic>>>uplink`, value: 500 }];
  await controller.collectUsage();
  snapshot = await controller.dispatch(request('usage-snapshot-2', 'admin.snapshot', { sessionId: session.sessionId }));
  assert.deepEqual([snapshot.users[0].usage.uplinkBytes, snapshot.users[0].usage.downlinkBytes], [3500, 4096]);
  assert.equal((await repository.readCurrent()).state.revision, 2);

  // Stats failures never affect authority or readiness.
  controller.usage = new UsageTracker({ path: path.join(dataDir, 'usage.json'), query: async () => { throw new Error('stats down'); } });
  assert.equal(await controller.collectUsage(), false);
  assert.equal(controller.ready, true);
});

test('a create replay never returns a password the administrator has since reset', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  const session = controller.sessions.issue();
  const createRequest = request('credential-operation-reset', 'user.create', {
    sessionId: session.sessionId, csrf: session.csrf, expectedRevision: 0, displayName: 'Reset after create',
  });
  const created = await controller.dispatch(createRequest);
  assert.deepEqual(await controller.dispatch(structuredClone(createRequest)), created);
  const reset = await controller.dispatch(request('reset-after-create', 'user.resetPassword', {
    sessionId: session.sessionId, csrf: created.csrf, expectedRevision: 1, userId: created.user.id,
  }));
  assert.notEqual(reset.rawPassword, created.rawPassword);
  await assert.rejects(controller.dispatch(structuredClone(createRequest)), (error) => (
    error.code === 'IDEMPOTENCY_STALE' && error.status === 409
  ));
  assert.equal((await repository.readCurrent()).state.revision, 2);
});
