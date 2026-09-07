import assert from 'node:assert/strict';

import test from 'node:test';
import { verifySubscriptionToken } from '../../src/core/credentials.js';
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
  assert.ok(created.subscriptionUrl.endsWith(`/s/${created.rawToken}`));
  assert.ok(created.vlessLink.startsWith('vless://'));
  await assert.rejects(controller.dispatch(request('token-is-not-admin', 'admin.snapshot', {
    sessionId: created.rawToken,
  })), (error) => error.code === 'UNAUTHORIZED' && error.status === 401);
  await assert.rejects(controller.dispatch(request('token-is-not-auth-check', 'auth.check', {
    sessionId: created.rawToken,
  })), (error) => error.code === 'UNAUTHORIZED' && error.status === 401);

  let current = await repository.readCurrent();
  assert.equal(current.state.users.length, 1);
  assert.equal(JSON.stringify(current.state).includes(created.rawToken), false);
  assert.equal(current.subscriptionView.users.length, 1);
  assert.equal(current.config.inbounds[0].users.length, 1);

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
