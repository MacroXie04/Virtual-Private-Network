import assert from 'node:assert/strict';

import test from 'node:test';

import { fixture, request } from '../fixtures/controller.js';

test('concurrent mutations serialize and reject the stale revision without losing an update', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  const first = controller.sessions.issue();
  const second = controller.sessions.issue();
  const results = await Promise.allSettled([
    controller.dispatch(request('create-a', 'user.create', {
      sessionId: first.sessionId,
      csrf: first.csrf,
      expectedRevision: 0,
      displayName: 'Alice',
    })),
    controller.dispatch(request('create-b', 'user.create', {
      sessionId: second.sessionId,
      csrf: second.csrf,
      expectedRevision: 0,
      displayName: 'Bob',
    })),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'STALE_REVISION');
  const rejectedIndex = results.findIndex((result) => result.status === 'rejected');
  const rejectedSession = rejectedIndex === 0 ? first : second;
  assert.equal(controller.sessions.currentCsrf(rejectedSession.sessionId), rejectedSession.csrf);
  const current = await repository.readCurrent();
  assert.equal(current.state.revision, 1);
  assert.equal(current.state.users.length, 1);
});

test('invalid mutations preserve the current CSRF token', async () => {
  const { controller } = await fixture();
  await controller.recover();
  const session = controller.sessions.issue();
  await assert.rejects(controller.dispatch(request('invalid-status', 'user.setStatus', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    userId: 'missing-user',
    status: 'not-a-status',
  })), (error) => error.code === 'INVALID' && error.status === 400);
  assert.equal(controller.sessions.currentCsrf(session.sessionId), session.csrf);
});
