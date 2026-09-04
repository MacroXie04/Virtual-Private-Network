import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GatewayController } from '../../src/controller.js';
import { ControllerSessions } from '../../src/controller-sessions.js';
import { createAdminScryptRecord, verifySubscriptionToken } from '../../src/credentials.js';
import { RevisionRepository } from '../../src/repository.js';

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

class FakeRuntime {
  constructor() {
    this.restarts = 0;
    this.probes = 0;
    this.failNextProbe = false;
  }

  async restart() {
    this.restarts += 1;
  }

  async probe() {
    this.probes += 1;
    if (this.failNextProbe) {
      this.failNextProbe = false;
      throw new Error('simulated data-path failure');
    }
    return true;
  }
}

async function fixture({
  authKey = null,
  apiKey = null,
  readExitDirectoryCredential = null,
} = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vpn-controller-'));
  const admin = await createAdminScryptRecord('correct horse battery staple', {
    randomBytesImpl: () => Buffer.alloc(16, 7),
  });
  const state = {
    schemaVersion: 2,
    revision: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    gateway: {
      host: { kind: 'dns', value: 'vpn.example.com' },
      advertisedPort: 443,
      listenPort: 8443,
      publicBaseUrl: 'https://subscriptions.example.com',
    },
    reality: {
      serverName: 'www.microsoft.com',
      privateKey: 'UuMBgl7MXTPx9inmQp2UC7Jcnwc6XYbwDNebonM-FCc', // gitleaks:allow -- deterministic test vector
      publicKey: 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0',
      shortId: '0123456789abcdef',
    },
    tailscale: {
      hostname: 'proxy-vps',
      stateDirectory: path.join(dataDir, 'tailscale'),
      authKey,
      apiKey,
      exitNode: '100.64.0.10',
    },
    health: {
      listenPort: 19080,
      username: 'vpn-health',
      password: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      target: { host: 'www.microsoft.com', port: 443 },
    },
    admin: { scrypt: admin },
    users: [],
  };
  const repository = new RevisionRepository(dataDir);
  await repository.initialize(state, { operation: 'initialize' });
  const runtime = new FakeRuntime();
  let uuidIndex = 0;
  let tokenIndex = 0;
  const sessions = new ControllerSessions({
    randomBytes: (length) => Buffer.alloc(length, ++tokenIndex),
  });
  const controller = new GatewayController({
    repository,
    runtime,
    sessions,
    validateConfig: async () => {},
    readExitDirectoryCredential,
    now: () => new Date(`2026-01-01T00:00:0${Math.min(9, uuidIndex + 1)}.000Z`),
  });
  const lifecycleOptions = {
    // Lifecycle generators use module defaults; deterministic collisions are
    // not required for these behavioral assertions.
    nextUuid: () => UUIDS[uuidIndex++],
  };
  return { controller, repository, runtime, dataDir, lifecycleOptions };
}

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

function request(id, op, fields = {}) {
  return { id, op, ...fields };
}

async function assertMarkerMissing(dataDir) {
  await assert.rejects(lstat(path.join(dataDir, 'maintenance')), (error) => error.code === 'ENOENT');
}

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
