import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { fixture, request, assertMarkerMissing } from '../fixtures/controller.js';

test('first routed recovery retires bootstrap credentials and their revision', async () => {
  const { controller, repository, runtime, dataDir } = await fixture({
    authKey: 'tskey-auth-bootstrap-only',
    apiKey: 'tskey-api-bootstrap-only',
    readExitDirectoryCredential: async () => 'tskey-api-live-file',
  });
  const recovered = await controller.recover();
  assert.equal(recovered.state.revision, 1);
  assert.equal(recovered.state.tailscale.authKey, null);
  assert.equal(recovered.state.tailscale.apiKey, null);
  assert.equal(Object.hasOwn(recovered.config.endpoints[0], 'auth_key'), false);
  assert.equal((await repository.listRevisions()).length, 1);
  assert.equal(runtime.restarts, 2);
  assert.equal(controller.ready, true);
  await assertMarkerMissing(dataDir);
});

test('credential-revision deletion is fail-closed and retries after an interrupted scrub', async () => {
  const { controller, repository, dataDir } = await fixture({
    authKey: 'tskey-auth-bootstrap-only',
    apiKey: 'tskey-api-bootstrap-only',
  });
  const removeRevision = repository.removeRevision.bind(repository);
  let failOnce = true;
  repository.removeRevision = async (id) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated credential cleanup interruption');
    }
    return removeRevision(id);
  };

  await assert.rejects(controller.recover(), (error) => error.code === 'RUNTIME_UNAVAILABLE');
  assert.equal(controller.ready, false);
  assert.equal((await lstat(path.join(dataDir, 'maintenance'))).isFile(), true);
  assert.equal((await repository.readCurrent()).manifest.operation, 'credentials.scrub');
  assert.equal((await repository.listRevisions()).length, 2);

  const recovered = await controller.recover();
  assert.equal(recovered.state.tailscale.authKey, null);
  assert.equal(recovered.state.tailscale.apiKey, null);
  assert.equal((await repository.listRevisions()).length, 1);
  assert.equal(controller.ready, true);
  await assertMarkerMissing(dataDir);
});

test('a later degraded exit repair cannot hide interrupted credential-history cleanup', async () => {
  const { controller, repository, dataDir } = await fixture({
    authKey: 'tskey-auth-bootstrap-only',
    apiKey: 'tskey-api-bootstrap-only',
    readExitDirectoryCredential: async () => 'tskey-api-live-file',
  });
  const removeRevision = repository.removeRevision.bind(repository);
  let failOnce = true;
  repository.removeRevision = async (id) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated cleanup interruption after scrub commit');
    }
    return removeRevision(id);
  };

  await assert.rejects(controller.recover(), (error) => error.code === 'RUNTIME_UNAVAILABLE');
  assert.equal((await repository.readCurrent()).manifest.operation, 'credentials.scrub');
  assert.equal((await repository.listRevisions()).length, 2);
  controller.exitDirectory = async () => [{
    deviceId: 'repair-after-scrub',
    name: 'repair-after-scrub',
    ipv4: '100.64.0.32',
    ipv6: null,
  }];
  const session = controller.sessions.issue();
  const result = await controller.dispatch(request('repair-after-scrub', 'exit.select', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 1,
    deviceId: 'repair-after-scrub',
  }));

  const revisions = await repository.listRevisions();
  assert.equal(result.revision, 2);
  assert.equal((await repository.readCurrent()).state.tailscale.exitNode, '100.64.0.32');
  assert.equal(revisions.length, 2);
  for (const revision of revisions) {
    const record = await repository.readRevision(revision.id);
    assert.equal(record.state.tailscale.authKey, null);
    assert.equal(record.state.tailscale.apiKey, null);
  }
  assert.equal(controller.ready, true);
  await assertMarkerMissing(dataDir);
});

test('degraded exit-node repair cannot publish readiness before credential retirement', async () => {
  const { controller, repository, runtime, dataDir } = await fixture({
    authKey: 'tskey-auth-bootstrap-only',
    apiKey: 'tskey-api-bootstrap-only',
    readExitDirectoryCredential: async () => 'tskey-api-live-file',
  });
  runtime.failNextProbe = true;
  await assert.rejects(controller.recover(), (error) => error.code === 'RUNTIME_UNAVAILABLE');
  assert.equal(controller.ready, false);

  controller.exitDirectory = async (credential) => {
    assert.equal(credential, 'tskey-api-live-file');
    return [{ deviceId: 'repair', name: 'repair', ipv4: '100.64.0.31', ipv6: null }];
  };
  const session = controller.sessions.issue();
  const repaired = await controller.dispatch(request('repair-and-retire', 'exit.select', {
    sessionId: session.sessionId,
    csrf: session.csrf,
    expectedRevision: 0,
    deviceId: 'repair',
  }));

  const current = await repository.readCurrent();
  assert.equal(repaired.revision, 2);
  assert.equal(current.state.revision, 2);
  assert.equal(current.state.tailscale.exitNode, '100.64.0.31');
  assert.equal(current.state.tailscale.authKey, null);
  assert.equal(current.state.tailscale.apiKey, null);
  assert.equal((await repository.listRevisions()).length, 1);
  assert.equal(controller.ready, true);
  await assertMarkerMissing(dataDir);
});

test('a healthy scrub rollback stays fail-closed and the next health check retries retirement', async () => {
  const { controller, repository, runtime, dataDir } = await fixture({
    authKey: 'tskey-auth-bootstrap-only',
    apiKey: 'tskey-api-bootstrap-only',
  });
  const probe = runtime.probe.bind(runtime);
  runtime.probe = async () => {
    if (runtime.probes === 1) {
      runtime.probes += 1;
      throw new Error('simulated credential-free candidate failure');
    }
    return probe();
  };

  await assert.rejects(controller.recover(), (error) => error.code === 'RUNTIME_UNAVAILABLE');
  let current = await repository.readCurrent();
  assert.equal(current.state.revision, 0);
  assert.equal(current.state.tailscale.authKey, 'tskey-auth-bootstrap-only');
  assert.equal(controller.ready, false);
  assert.equal((await lstat(path.join(dataDir, 'maintenance'))).isFile(), true);

  const result = await controller.dispatch(request('retry-retirement', 'health.status'));
  current = await repository.readCurrent();
  assert.deepEqual(result, { status: 'ok', revision: 1 });
  assert.equal(current.state.tailscale.authKey, null);
  assert.equal(current.state.tailscale.apiKey, null);
  assert.equal(controller.ready, true);
  await assertMarkerMissing(dataDir);
});
