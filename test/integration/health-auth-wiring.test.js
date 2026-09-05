import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createControllerApplication } from '../../src/controller-server.js';
import { RevisionRepository } from '../../src/repository.js';
import { fixtureState } from '../unit/core-v2-fixture.js';

test('controller runtime receives the exact authenticated health inbound credentials', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vpn-health-wiring-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = path.join(parent, 'data');
  const runDir = path.join(parent, 'run');
  await mkdir(runDir, { mode: 0o700 });
  const state = fixtureState({
    tailscale: {
      ...fixtureState().tailscale,
      stateDirectory: path.join(dataDir, 'tailscale'),
    },
  });
  const repository = new RevisionRepository(dataDir);
  await repository.initialize(state, { operation: 'bootstrap' });
  const controller = {
    sessions: { destroyAll() {} },
    markUnready() {},
    async recover() {},
    async dispatch() { return {}; },
  };
  const application = await createControllerApplication({
    env: {
      DATA_DIR: dataDir,
      CONTROLLER_SOCKET: path.join(runDir, 'controller.sock'),
      SINGBOX_CONFIG: path.join(dataDir, 'runtime', 'sing-box.json'),
      SINGBOX_GID: String(process.getgid?.() ?? 0),
      SUB_GID: String(process.getgid?.() ?? 0),
      ADMIN_GID: String(process.getgid?.() ?? 0),
      ADMIN_PUBLIC_HOSTNAME: state.gateway.adminPublicHostname,
      SUPERVISE: '0',
    },
    repository,
    controller,
    socketUid: null,
  });

  assert.equal(application.runtime.health.username, state.health.username);
  assert.equal(application.runtime.health.password, state.health.password);
  assert.equal(application.runtime.health.listenPort, state.health.listenPort);
  assert.deepEqual(application.runtime.health.websocket, {
    connectHost: '127.0.0.1',
    connectPort: 8443,
    authority: state.gateway.vpnPublicHostname,
    path: state.gateway.websocketPath,
  });
  await application.close();
});
