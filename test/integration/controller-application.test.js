import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createControlClient } from '../../src/control/control-client.js';
import {
  createControllerApplication,
  notifyServiceReady,
  runDataPathWatchdog,
  spawnWebProcesses,
} from '../../src/control/controller-server.js';
import { RevisionRepository } from '../../src/state/repository.js';
import { fixtureState } from '../fixtures/state.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vpn-application-'));
  const dataDir = path.join(parent, 'data');
  const runDir = path.join(parent, 'run');
  await mkdir(runDir, { mode: 0o700 });
  const repository = new RevisionRepository(dataDir);
  await repository.initialize(fixtureState({
    tailscale: {
      ...fixtureState().tailscale,
      stateDirectory: path.join(dataDir, 'tailscale'),
    },
  }), { operation: 'bootstrap' });
  const socketPath = path.join(runDir, 'controller.sock');
  const env = {
    DATA_DIR: dataDir,
    CONTROLLER_SOCKET: socketPath,
    SINGBOX_CONFIG: path.join(dataDir, 'runtime', 'sing-box.json'),
    SINGBOX_GID: String(process.getgid?.() ?? 0),
    SUB_GID: String(process.getgid?.() ?? 0),
    ADMIN_GID: String(process.getgid?.() ?? 0),
    ADMIN_PUBLIC_HOSTNAME: 'admin.example.com',
    SUPERVISE: '0',
  };
  return { parent, dataDir, socketPath, repository, env };
}

test('supervised HTTP processes resolve existing entry files from the application root', async (t) => {
  const calls = [];
  const failures = [];
  const web = spawnWebProcesses({
    env: {
      DATA_DIR: '/data',
      CONTROLLER_SOCKET: '/run/vpn-gateway/controller.sock',
      ADMIN_PUBLIC_HOSTNAME: 'admin.example.com',
      TS_AUTH_KEY_FILE: '/private/tailscale-key',
      CLOUDFLARE_TUNNEL_TOKEN_FILE: '/private/tunnel-token',
    },
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => {
        child.signalCode = signal;
        queueMicrotask(() => child.emit('exit', null, signal));
        return true;
      };
      calls.push({ command, args, options, child });
      return child;
    },
    onUnexpectedExit: (error) => failures.push(error),
  });
  t.after(() => web.stop());

  assert.equal(calls.length, 2);
  const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  for (const [index, call] of calls.entries()) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.args.length, 1);
    assert.equal(path.isAbsolute(call.args[0]), true);
    assert.equal((await lstat(call.args[0])).isFile(), true);
    assert.equal(path.resolve(call.options.cwd), projectRoot);
    assert.deepEqual(call.options.stdio, ['ignore', 'inherit', 'inherit']);
    assert.equal(call.options.uid, 11001 + index);
    assert.equal(call.options.gid, 11001 + index);
    assert.equal(call.options.env.TS_AUTH_KEY_FILE, undefined);
    assert.equal(call.options.env.CLOUDFLARE_TUNNEL_TOKEN_FILE, undefined);
  }
  const subscription = await import(calls[0].args[0]);
  const administration = await import(calls[1].args[0]);
  assert.equal(typeof subscription.createSubscriptionServer, 'function');
  assert.equal(typeof administration.createAdminServer, 'function');
  assert.equal(calls[0].options.env.DATA_DIR, '/data');
  assert.equal(calls[1].options.env.CONTROLLER_SOCKET, '/run/vpn-gateway/controller.sock');
  assert.equal(calls[1].options.env.ADMIN_PUBLIC_HOSTNAME, 'admin.example.com');
  await web.stop();
  assert.deepEqual(failures, []);
});

test('systemd readiness notification is explicit, fixed, and optional', async () => {
  const calls = [];
  assert.equal(await notifyServiceReady({
    env: {},
    execFile: async (...args) => calls.push(args),
  }), false);
  assert.equal(await notifyServiceReady({
    env: { NOTIFY_SOCKET: '/run/systemd/notify' },
    execFile: async (...args) => calls.push(args),
  }), true);
  assert.deepEqual(calls, [[
    '/usr/bin/systemd-notify',
    ['--ready', '--pid=parent'],
    {
      timeout: 5_000,
      maxBuffer: 4_096,
      env: { NOTIFY_SOCKET: '/run/systemd/notify' },
    },
  ]]);
});

test('the recurring data-path watchdog makes every failed probe fail closed', async () => {
  const events = [];
  const authority = {
    dispatch: async () => { throw new Error('data path failed'); },
    markUnready: () => events.push('unready'),
    setMaintenance: async (active) => events.push(`maintenance:${active}`),
  };
  assert.equal(await runDataPathWatchdog(authority), false);
  assert.deepEqual(events, ['unready', 'maintenance:true']);

  authority.setMaintenance = async () => { throw new Error('state path failed'); };
  await assert.rejects(
    runDataPathWatchdog(authority),
    /could not publish maintenance state/u,
  );

  authority.dispatch = async () => ({ status: 'ok' });
  assert.equal(await runDataPathWatchdog(authority), true);
});

test('controller requires ADMIN_PUBLIC_HOSTNAME to match canonical state', async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const authority = {
    sessions: { destroyAll() {} },
    markUnready() {},
    async recover() {},
    async dispatch() { return {}; },
  };
  const options = {
    repository: fixture.repository,
    runtime: {},
    controller: authority,
    socketUid: null,
  };
  const missing = { ...fixture.env };
  delete missing.ADMIN_PUBLIC_HOSTNAME;
  await assert.rejects(
    createControllerApplication({ ...options, env: missing }),
    /ADMIN_PUBLIC_HOSTNAME/u,
  );
  await assert.rejects(
    createControllerApplication({
      ...options,
      env: { ...fixture.env, ADMIN_PUBLIC_HOSTNAME: 'other.example.com' },
    }),
    /must match canonical gateway state/u,
  );
});

test('controller publishes its socket only after runtime recovery succeeds', async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const gate = deferred();
  const events = [];
  const authority = {
    sessions: { destroyAll: () => events.push('sessions.destroy') },
    markUnready: () => events.push('unready'),
    recover: async () => { events.push('recover.begin'); await gate.promise; events.push('recover.end'); },
    dispatch: async () => ({ status: 'ok', revision: 1 }),
  };
  const application = await createControllerApplication({
    env: fixture.env,
    repository: fixture.repository,
    runtime: {},
    controller: authority,
    socketUid: null,
    notifyReady: async () => {
      assert.equal((await lstat(fixture.socketPath)).isSocket(), true);
      events.push('ready');
    },
  });
  const starting = application.start();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(lstat(fixture.socketPath), (error) => error.code === 'ENOENT');
  gate.resolve();
  await starting;
  assert.equal((await lstat(fixture.socketPath)).isSocket(), true);
  assert.deepEqual(
    await createControlClient({ socketPath: fixture.socketPath, timeoutMs: 1_000 }).health(),
    { status: 'ok', revision: 1 },
  );
  await application.close();
  await assert.rejects(lstat(fixture.socketPath), (error) => error.code === 'ENOENT');
  assert.deepEqual(events.slice(0, 2), ['recover.begin', 'recover.end']);
  assert.equal(events.includes('ready'), true);
});

test('shutdown racing startup cannot publish a late socket', async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const gate = deferred();
  const authority = {
    sessions: { destroyAll: () => {} },
    markUnready: () => {},
    recover: () => gate.promise,
    dispatch: async () => ({}),
  };
  const application = await createControllerApplication({
    env: fixture.env,
    repository: fixture.repository,
    runtime: {},
    controller: authority,
    socketUid: null,
  });
  const starting = application.start();
  await new Promise((resolve) => setImmediate(resolve));
  const closing = application.close();
  gate.resolve();
  await assert.rejects(starting, /startup was interrupted/u);
  await closing;
  await assert.rejects(lstat(fixture.socketPath), (error) => error.code === 'ENOENT');
});

test('runtime recovery failure keeps the repair control plane available', async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const events = [];
  const authority = {
    sessions: { destroyAll: () => {} },
    markUnready: () => events.push('unready'),
    drain: async () => {},
    recover: async () => {
      throw Object.assign(new Error('routed probe failed'), { code: 'RUNTIME_UNAVAILABLE', status: 503 });
    },
    dispatch: async () => ({ status: 'degraded' }),
  };
  const application = await createControllerApplication({
    env: fixture.env,
    repository: fixture.repository,
    runtime: {},
    controller: authority,
    socketUid: null,
  });
  await application.start();
  assert.equal((await lstat(fixture.socketPath)).isSocket(), true);
  const response = await createControlClient({
    socketPath: fixture.socketPath,
    timeoutMs: 1_000,
  }).request('admin.snapshot');
  assert.deepEqual(response, { status: 'degraded' });
  await application.close();
});

test('non-runtime recovery failures abort before publishing a control socket', async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const authority = {
    sessions: { destroyAll: () => {} },
    markUnready: () => {},
    drain: async () => {},
    recover: async () => { throw new Error('state integrity failed'); },
    dispatch: async () => ({}),
  };
  const application = await createControllerApplication({
    env: fixture.env,
    repository: fixture.repository,
    runtime: {},
    controller: authority,
    socketUid: null,
  });
  await assert.rejects(application.start(), /state integrity failed/u);
  await assert.rejects(lstat(fixture.socketPath), (error) => error.code === 'ENOENT');
});
