import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { fixture, request, assertMarkerMissing } from '../fixtures/controller.js';

test('exit-node changes require a freshly resolved stable device ID', async () => {
  const { controller, repository } = await fixture();
  await controller.recover();
  const current = await repository.readCurrent();
  const withApi = {
    ...current.state,
    revision: 1,
    updatedAt: '2026-01-01T00:00:01.000Z',
    tailscale: { ...current.state.tailscale, apiKey: 'tskey-api-test-only' },
  };
  const revision = await repository.createRevision(withApi, { operation: 'test.api-key' });
  await repository.activateRuntime(revision.id);
  await repository.activateCurrent(revision.id);
  controller.exitDirectory = async () => [{
    deviceId: 'device-1', name: 'home-exit', ipv4: '100.64.0.20', ipv6: null,
  }];
  const session = controller.sessions.issue();
  const result = await controller.dispatch(request('exit-1', 'exit.select', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 1,
    deviceId: 'device-1',
  }));
  assert.equal(result.exitNode.address, '100.64.0.20');
  assert.equal((await repository.readCurrent()).state.tailscale.exitNode, '100.64.0.20');
});

test('a failed health probe fails closed while a validated exit-node repair remains available', async () => {
  const { controller, repository, runtime, dataDir } = await fixture();
  await controller.recover();
  controller.readExitDirectoryCredential = async () => 'replacement-api-credential';

  runtime.failNextProbe = true;
  await assert.rejects(
    controller.dispatch(request('health-fail', 'health.status')),
    (error) => error.code === 'RUNTIME_UNAVAILABLE' && error.status === 503,
  );
  assert.equal(controller.ready, false);
  assert.equal((await lstat(path.join(dataDir, 'maintenance'))).isFile(), true);

  const session = controller.sessions.issue();
  await assert.rejects(controller.dispatch(request('blocked-create', 'user.create', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    displayName: 'Blocked while degraded',
  })), (error) => error.code === 'RUNTIME_UNAVAILABLE');

  controller.exitDirectory = async (credential) => {
    assert.equal(credential, 'replacement-api-credential');
    return [{ deviceId: 'repair-exit', name: 'repair-exit', ipv4: '100.64.0.30', ipv6: null }];
  };
  const repaired = await controller.dispatch(request('repair-exit', 'exit.select', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    deviceId: 'repair-exit',
  }));
  assert.equal(repaired.exitNode.address, '100.64.0.30');
  assert.equal(controller.ready, true);
  assert.equal((await repository.readCurrent()).state.tailscale.exitNode, '100.64.0.30');
  await assertMarkerMissing(dataDir);
});

test('a later health check retries recovery and clears a transient fail-closed latch', async () => {
  const { controller, runtime, dataDir } = await fixture();
  await controller.recover();
  runtime.failNextProbe = true;
  await assert.rejects(
    controller.dispatch(request('health-transient-fail', 'health.status')),
    (error) => error.code === 'RUNTIME_UNAVAILABLE',
  );
  assert.equal(controller.ready, false);
  assert.equal((await lstat(path.join(dataDir, 'maintenance'))).isFile(), true);

  assert.deepEqual(
    await controller.dispatch(request('health-recovered', 'health.status')),
    { status: 'ok', revision: 0 },
  );
  assert.equal(controller.ready, true);
  await assertMarkerMissing(dataDir);
});

test('maintenance cleanup failure cannot leave a falsely ready controller', async () => {
  const { controller, dataDir } = await fixture();
  const setMaintenance = controller.setMaintenance.bind(controller);
  let failOnce = true;
  controller.setMaintenance = async (active) => {
    if (!active && failOnce) {
      failOnce = false;
      throw new Error('simulated marker removal failure');
    }
    return setMaintenance(active);
  };
  await assert.rejects(controller.recover(), (error) => error.code === 'RUNTIME_UNAVAILABLE');
  assert.equal(controller.ready, false);
  assert.equal((await lstat(path.join(dataDir, 'maintenance'))).isFile(), true);
  assert.deepEqual(
    await controller.dispatch(request('health-after-marker-failure', 'health.status')),
    { status: 'ok', revision: 0 },
  );
  assert.equal(controller.ready, true);
  await assertMarkerMissing(dataDir);
});
