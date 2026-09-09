import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GatewayController } from '../../src/control/authority/controller.js';
import { exitProfileId, deriveExitUuid } from '../../src/core/identity/exit-profiles.js';
import { buildRuntimeHealth } from '../../src/core/server/render.js';
import { renderClientSubscription } from '../../src/core/subscriptions/clients.js';
import { RevisionRepository } from '../../src/state/repository.js';
import { fixtureState } from '../fixtures/state.js';

const enrollmentKey = 'tskey-auth-extra-exit-one-time';
const tokyo = { deviceId: 'tokyo-device', name: 'tokyo', ipv4: '100.64.0.3', ipv6: null };

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vpn-client-exits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = fixtureState();
  state.tailscale = { ...state.tailscale, authKey: null, apiKey: null, stateDirectory: path.join(root, 'tailscale') };
  const repository = new RevisionRepository(root);
  await repository.initialize(state, { operation: 'bootstrap' });
  const observed = [];
  let rejectExtra = false;
  let keyReads = 0;
  const runtime = {
    async restart() {},
    async probe() {
      const current = await repository.readRuntime();
      assert.deepEqual(this.health, buildRuntimeHealth(current.state));
      observed.push(current);
      if (rejectExtra && current.config.endpoints.length > 1) throw new Error('extra exit unavailable');
      return true;
    },
  };
  const controller = new GatewayController({
    repository, runtime, validateConfig: async () => {},
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    readExitDirectoryCredential: async () => 'tskey-api-directory-fixture',
    exitDirectory: async () => [tokyo],
    readEnrollmentCredential: async () => { keyReads += 1; return enrollmentKey; },
  });
  await controller.recover();
  const session = controller.sessions.issue();
  let sequence = 0;
  const mutate = async (op, fields = {}) => controller.dispatch({
    id: `client-exit-${++sequence}`, op,
    sessionId: session.sessionId,
    csrf: controller.sessions.currentCsrf(session.sessionId),
    expectedRevision: (await repository.readCurrent()).state.revision,
    ...fields,
  });
  return { root, state, repository, controller, runtime, session, observed, mutate,
    keyReads: () => keyReads, failExtra: () => { rejectExtra = true; } };
}

test('publishing an exit enrolls only its identity, probes the candidate, and scrubs all credential history', async (t) => {
  const f = await setup(t);
  const result = await f.mutate('exit.add', { deviceId: tokyo.deviceId });
  const current = await f.repository.readCurrent();
  const id = exitProfileId(tokyo.deviceId);
  assert.equal(result.revision, f.state.revision + 2);
  assert.equal(f.keyReads(), 1);
  assert.equal(f.controller.ready, true);
  const enrolled = f.observed.find((record) => record.state.tailscale.extraExits?.[0].authKey === enrollmentKey);
  assert.ok(enrolled, 'new identity must be probed before its credential is scrubbed');
  assert.equal(enrolled.config.endpoints[0].auth_key, undefined);
  assert.equal(enrolled.config.endpoints[1].auth_key, enrollmentKey);
  assert.equal(enrolled.config.endpoints[0].state_directory, f.state.tailscale.stateDirectory);
  assert.equal(enrolled.config.endpoints[1].state_directory, path.join(f.state.tailscale.stateDirectory, 'exits', id));
  assert.equal(current.state.tailscale.extraExits[0].authKey, null);
  assert.equal(current.config.endpoints.every((endpoint) => !Object.hasOwn(endpoint, 'auth_key')), true);
  for (const revision of await f.repository.listRevisions()) {
    for (const file of ['state.json', 'sing-box.json', 'subscription-view.json']) {
      const content = await readFile(path.join(f.root, 'revisions', revision.id, file), 'utf8');
      assert.equal(content.includes(enrollmentKey), false);
    }
  }
  const snapshot = await f.controller.snapshot(f.session.sessionId);
  assert.deepEqual(snapshot.selectableExits, [{ id, name: tokyo.name, address: tokyo.ipv4 }]);
  assert.equal(JSON.stringify(snapshot).includes(enrollmentKey), false);
  const links = renderClientSubscription(current.subscriptionView, 'alice', 'links').trim().split('\n').map((link) => new URL(link));
  assert.equal(links.length, 2);
  assert.equal(links[0].username, f.state.users[0].uuid);
  assert.equal(links[1].username, deriveExitUuid(f.state.users[0].uuid, id));
  assert.notEqual(links[0].username, links[1].username);
  assert.equal(links[0].host, links[1].host);
  assert.equal(links[0].searchParams.get('path'), links[1].searchParams.get('path'));
  assert.equal(JSON.stringify(current.subscriptionView).includes(tokyo.ipv4), false);
});

test('an unpublished or duplicate exit is rejected before enrollment credentials are read', async (t) => {
  const f = await setup(t);
  await assert.rejects(f.mutate('exit.add', { deviceId: 'unknown' }), { code: 'EXIT_NODE_NOT_AVAILABLE' });
  assert.equal(f.keyReads(), 0);
  await f.mutate('exit.add', { deviceId: tokyo.deviceId });
  await assert.rejects(f.mutate('exit.add', { deviceId: tokyo.deviceId }), { code: 'EXIT_ALREADY_PUBLISHED' });
  assert.equal(f.keyReads(), 1);
});

test('failed enrollment restores the old configuration and its exact health profiles', async (t) => {
  const f = await setup(t);
  const old = await f.repository.readCurrent();
  f.failExtra();
  await assert.rejects(f.mutate('exit.add', { deviceId: tokyo.deviceId }), { code: 'ROLLED_BACK' });
  assert.equal((await f.repository.readCurrent()).id, old.id);
  assert.equal((await f.repository.readRuntime()).id, old.id);
  assert.deepEqual(f.runtime.health, buildRuntimeHealth(old.state));
  assert.equal((await f.repository.listRevisions()).length, 1);
  await f.controller.recover();
  assert.equal(f.controller.ready, true);
});

test('a degraded gateway can remove a failed extra exit without the directory or enrollment key', async (t) => {
  const f = await setup(t);
  await f.mutate('exit.add', { deviceId: tokyo.deviceId });
  f.failExtra();
  await assert.rejects(f.controller.dispatch({ id: 'health-fails', op: 'health.status' }), { code: 'RUNTIME_UNAVAILABLE' });
  f.controller.readEnrollmentCredential = null;
  f.controller.readExitDirectoryCredential = async () => { throw new Error('directory unavailable'); };
  await f.mutate('exit.remove', { exitId: exitProfileId(tokyo.deviceId) });
  const current = await f.repository.readCurrent();
  assert.equal(current.config.endpoints.length, 1);
  assert.equal(current.config.inbounds[0].users.length, 1);
  assert.equal(current.state.tailscale.extraExits.length, 0);
  assert.equal(f.controller.ready, true);
  assert.equal(f.keyReads(), 1);
});

test('credential rotation and user disable invalidate every exit credential together', async (t) => {
  const f = await setup(t);
  await f.mutate('exit.add', { deviceId: tokyo.deviceId });
  const before = await f.repository.readCurrent();
  const oldIds = before.config.inbounds[0].users.map((user) => user.uuid);
  await f.mutate('user.rotateCredentials', { userId: 'alice' });
  const rotated = await f.repository.readCurrent();
  assert.equal(rotated.config.inbounds[0].users.length, 2);
  assert.ok(rotated.config.inbounds[0].users.every((user) => !oldIds.includes(user.uuid)));
  await f.mutate('user.setStatus', { userId: 'alice', status: 'disabled' });
  const disabled = await f.repository.readCurrent();
  assert.equal(disabled.config.inbounds[0].users.length, 0);
  assert.equal(disabled.subscriptionView.users.length, 0);
  await f.mutate('user.setStatus', { userId: 'alice', status: 'active' });
  const enabled = await f.repository.readCurrent();
  assert.deepEqual(enabled.config.inbounds[0].users, rotated.config.inbounds[0].users);
  await f.mutate('user.revoke', { userId: 'alice', confirmName: 'Alice' });
  assert.equal((await f.repository.readCurrent()).config.inbounds[0].users.length, 0);
});

test('multiple failed exits can be removed one at a time while subscriptions remain in maintenance', async (t) => {
  const f = await setup(t);
  const seoul = { deviceId: 'seoul-device', name: 'seoul', ipv4: '100.64.0.4', ipv6: null };
  f.controller.exitDirectory = async () => [tokyo, seoul];
  await f.mutate('exit.add', { deviceId: tokyo.deviceId });
  await f.mutate('exit.add', { deviceId: seoul.deviceId });
  f.failExtra();
  await assert.rejects(f.controller.dispatch({ id: 'both-down', op: 'health.status' }), { code: 'RUNTIME_UNAVAILABLE' });
  await f.mutate('exit.remove', { exitId: exitProfileId(tokyo.deviceId) });
  let current = await f.repository.readCurrent();
  assert.equal(current.state.tailscale.extraExits.length, 1);
  assert.equal(current.state.tailscale.extraExits[0].id, exitProfileId(seoul.deviceId));
  assert.equal(f.controller.ready, false);
  await readFile(path.join(f.root, 'maintenance'));
  await f.mutate('exit.remove', { exitId: exitProfileId(seoul.deviceId) });
  current = await f.repository.readCurrent();
  assert.equal(current.state.tailscale.extraExits.length, 0);
  assert.equal(f.controller.ready, true);
  await assert.rejects(readFile(path.join(f.root, 'maintenance')), { code: 'ENOENT' });
});

test('rejected enrollment with interrupted candidate cleanup stays closed until recovery retires its key', async (t) => {
  const f = await setup(t);
  f.controller.validateConfig = async () => { throw new Error('candidate invalid'); };
  const removeRevision = f.repository.removeRevision.bind(f.repository);
  f.repository.removeRevision = async () => { throw new Error('cleanup interrupted'); };
  await assert.rejects(f.mutate('exit.add', { deviceId: tokyo.deviceId }), { code: 'CANDIDATE_REJECTED' });
  assert.equal(f.controller.ready, false);
  await readFile(path.join(f.root, 'maintenance'));
  assert.equal((await f.repository.listRevisions()).length, 2);
  f.controller.validateConfig = async () => {};
  f.repository.removeRevision = removeRevision;
  await f.controller.dispatch({ id: 'retry-cleanup', op: 'health.status' });
  assert.equal(f.controller.ready, true);
  assert.equal((await f.repository.listRevisions()).length, 1);
  assert.equal((await f.repository.readCurrent()).state.tailscale.extraExits, undefined);
});

test('exit mutations require the existing administrator session, CSRF, and revision authority', async (t) => {
  const f = await setup(t);
  const fields = { id: 'unauthorized-exit', op: 'exit.add', deviceId: tokyo.deviceId,
    sessionId: f.session.sessionId, csrf: f.session.csrf, expectedRevision: f.state.revision };
  await assert.rejects(f.controller.dispatch({ ...fields, csrf: 'wrong' }), { code: 'FORBIDDEN' });
  await assert.rejects(f.controller.dispatch({ ...fields, expectedRevision: 0 }), { code: 'STALE_REVISION' });
  await assert.rejects(f.controller.dispatch({ ...fields, address: '100.64.0.99' }), { code: 'INVALID' });
  assert.equal(f.keyReads(), 0);
});
