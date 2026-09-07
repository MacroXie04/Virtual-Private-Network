import assert from 'node:assert/strict';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { fixture, request, assertMarkerMissing } from '../fixtures/controller.js';

test('outer deployment journals block repository mutations until installer commit', async () => {
  const { controller, repository, dataDir } = await fixture();
  await controller.recover();
  const session = controller.sessions.issue();
  for (const [index, markerName] of [
    '.legacy-migration-in-progress',
    '.upgrade-restart-in-progress',
    '.upgrade-rollback-in-progress',
  ].entries()) {
    const markerPath = path.join(dataDir, markerName);
    await writeFile(markerPath, 'pending\n', { mode: 0o600 });
    await assert.rejects(controller.dispatch(request(`blocked-before-commit-${index}`, 'user.create', {
      sessionId: session.sessionId,
      csrf: session.csrf,
      expectedRevision: 0,
      displayName: 'Must Not Commit',
    })), (error) => error.code === 'DEPLOYMENT_NOT_COMMITTED' && error.status === 503);
    assert.equal((await repository.readCurrent()).state.revision, 0);
    await unlink(markerPath);
  }
  const created = await controller.dispatch(request('allowed-after-commit', 'user.create', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    displayName: 'Committed User',
  }));
  assert.equal(created.revision, 1);
});

test('controller rolls runtime and authority back when the routed readiness probe fails', async () => {
  const { controller, repository, runtime, dataDir } = await fixture();
  await controller.recover();
  const session = controller.sessions.issue();
  runtime.failNextProbe = true;
  await assert.rejects(controller.dispatch(request('create-fail', 'user.create', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    displayName: 'Rollback user',
  })), (error) => error.code === 'ROLLED_BACK' && error.status === 503);
  const current = await repository.readCurrent();
  const runtimeRevision = await repository.readRuntime();
  assert.equal(current.state.revision, 0);
  assert.equal(runtimeRevision.id, current.id);
  assert.equal(current.state.users.length, 0);
  assert.equal(controller.ready, true);
  assert.equal(runtime.restarts, 3);
  assert.equal(controller.sessions.currentCsrf(session.sessionId), session.csrf);
  await assertMarkerMissing(dataDir);
});

test('a rejected candidate is audited and removed before any pointer changes', async () => {
  const { controller, repository, dataDir } = await fixture();
  await controller.recover();
  controller.validateConfig = async () => { throw new Error('simulated semantic rejection'); };
  const session = controller.sessions.issue();
  await assert.rejects(controller.dispatch(request('candidate-fail', 'user.create', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    displayName: 'Rejected user',
  })), (error) => error.code === 'CANDIDATE_REJECTED' && error.status === 503);
  assert.equal((await repository.readCurrent()).state.revision, 0);
  assert.equal((await repository.readRuntime()).state.revision, 0);
  assert.equal((await repository.listRevisions()).length, 1);
  assert.equal(controller.ready, true);
  await assertMarkerMissing(dataDir);
});

test('runtime-pointer activation failure restores authority and clears maintenance', async () => {
  const { controller, repository, dataDir } = await fixture();
  await controller.recover();
  const previous = await repository.readCurrent();
  const activateRuntime = repository.activateRuntime.bind(repository);
  let failed = false;
  repository.activateRuntime = async (id) => {
    if (!failed && id !== previous.id) {
      failed = true;
      throw new Error('simulated runtime pointer failure');
    }
    return activateRuntime(id);
  };
  const session = controller.sessions.issue();
  await assert.rejects(controller.dispatch(request('activate-runtime-fail', 'user.create', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    displayName: 'Pointer failure',
  })), (error) => error.code === 'ROLLED_BACK' && error.status === 503);

  assert.equal((await repository.readCurrent()).id, previous.id);
  assert.equal((await repository.readRuntime()).id, previous.id);
  assert.equal(controller.ready, true);
  assert.equal(controller.sessions.currentCsrf(session.sessionId), session.csrf);
  await assertMarkerMissing(dataDir);
});

test('failure after current activation restores both pointers and clears maintenance', async () => {
  const { controller, repository, dataDir } = await fixture();
  await controller.recover();
  const previous = await repository.readCurrent();
  const activateCurrent = repository.activateCurrent.bind(repository);
  let candidateWasCurrent = false;
  repository.activateCurrent = async (id) => {
    if (id !== previous.id) candidateWasCurrent = true;
    return activateCurrent(id);
  };
  const setMaintenance = controller.setMaintenance.bind(controller);
  let failedDeactivation = false;
  controller.setMaintenance = async (active) => {
    if (!active && !failedDeactivation) {
      failedDeactivation = true;
      throw new Error('simulated marker unlink failure');
    }
    return setMaintenance(active);
  };
  const session = controller.sessions.issue();
  await assert.rejects(controller.dispatch(request('post-current-fail', 'user.create', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    displayName: 'Post-current failure',
  })), (error) => error.code === 'ROLLED_BACK' && error.status === 503);

  assert.equal(candidateWasCurrent, true);
  assert.equal((await repository.readCurrent()).id, previous.id);
  assert.equal((await repository.readRuntime()).id, previous.id);
  assert.equal(controller.ready, true);
  assert.equal(controller.sessions.currentCsrf(session.sessionId), session.csrf);
  await assertMarkerMissing(dataDir);
});

test('an unproven rollback leaves maintenance active and the controller unready', async () => {
  const { controller, repository, runtime, dataDir } = await fixture();
  await controller.recover();
  runtime.probe = async () => { throw new Error('simulated persistent data-path failure'); };
  const session = controller.sessions.issue();
  await assert.rejects(controller.dispatch(request('rollback-fail', 'user.create', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    displayName: 'Failed rollback',
  })), (error) => error.code === 'ROLLBACK_FAILED' && error.status === 503);

  assert.equal(controller.ready, false);
  assert.equal((await lstat(path.join(dataDir, 'maintenance'))).isFile(), true);
  assert.equal(controller.sessions.currentCsrf(session.sessionId), session.csrf);
  assert.equal((await repository.readCurrent()).state.revision, 0);
  assert.equal((await repository.readRuntime()).state.revision, 0);
});

test('controller audit history rotates to a bounded previous file', async () => {
  const { controller, dataDir } = await fixture();
  const auditPath = path.join(dataDir, 'audit.jsonl');
  await writeFile(auditPath, Buffer.alloc(1024 * 1024 - 1, 0x20), { mode: 0o600 });
  await controller.appendAudit({ operation: 'test.rotation', revision: 1, outcome: 'committed' });

  const [currentStat, previousStat] = await Promise.all([
    lstat(auditPath),
    lstat(`${auditPath}.previous`),
  ]);
  assert.ok(currentStat.size < 1024);
  assert.equal(previousStat.size, 1024 * 1024 - 1);
  assert.equal(currentStat.mode & 0o777, 0o600);
  const event = JSON.parse((await readFile(auditPath, 'utf8')).trim());
  assert.equal(event.operation, 'test.rotation');
  assert.equal(event.outcome, 'committed');
});
