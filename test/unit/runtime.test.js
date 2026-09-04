import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  SupervisedSingBoxRuntime,
  SystemdSingBoxRuntime,
  validateSingBoxConfig,
  waitForDataPath,
} from '../../src/runtime.js';

test('config validation invokes a fixed executable without a shell and sanitizes failure', async () => {
  const calls = [];
  await validateSingBoxConfig('/data/revisions/1/sing-box.json', {
    execFile: async (...args) => calls.push(args),
  });
  assert.deepEqual(calls[0][1], ['check', '-c', '/data/revisions/1/sing-box.json']);

  await assert.rejects(validateSingBoxConfig('/secret/key', {
    execFile: async () => { throw new Error('auth_key=do-not-leak'); },
  }), (error) => {
    assert.equal(error.message.includes('do-not-leak'), false);
    return true;
  });
});

test('readiness retries the routed probe and eventually succeeds', async () => {
  let attempts = 0;
  let time = 0;
  const health = {
    listenPort: 19080,
    username: 'vpn-health',
    password: 'health-password',
    targetHost: '1.1.1.1',
    targetPort: 443,
  };
  await waitForDataPath(health, {
    probe: async (options) => {
      attempts += 1;
      assert.equal(options.username, health.username);
      assert.equal(options.password, health.password);
      if (attempts < 3) throw new Error('not ready');
    },
    now: () => time,
    wait: async (milliseconds) => { time += milliseconds; },
    timeoutMs: 1000,
    intervalMs: 10,
  });
  assert.equal(attempts, 3);
});

test('supervised runtime restarts its exact child', async () => {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, signal));
      return true;
    };
    children.push(child);
    return child;
  };
  const runtime = new SupervisedSingBoxRuntime({
    configPath: '/data/runtime/sing-box.json',
    health: {},
    spawn,
    probe: async () => true,
  });
  await runtime.start();
  await runtime.restart();
  assert.equal(children.length, 2);
  assert.equal(runtime.isRunning(), true);
});

test('supervised runtime treats a signal-terminated child as stopped', async () => {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    children.push(child);
    return child;
  };
  const runtime = new SupervisedSingBoxRuntime({
    configPath: '/data/runtime/sing-box.json',
    health: {},
    spawn,
    probe: async () => true,
  });
  await runtime.start();
  children[0].signalCode = 'SIGKILL';

  assert.equal(runtime.isRunning(), false);
  await assert.rejects(runtime.probe(), /not running/u);
  await runtime.start();
  assert.equal(children.length, 2);
  assert.equal(runtime.isRunning(), true);
});

test('supervised restart never spawns a replacement before the old child exits', async () => {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      return true;
    };
    children.push(child);
    return child;
  };
  const runtime = new SupervisedSingBoxRuntime({
    configPath: '/data/runtime/sing-box.json',
    health: {},
    spawn,
    probe: async () => true,
    stopTimeoutMs: 5,
    killTimeoutMs: 100,
  });
  await runtime.start();
  const restarting = runtime.restart();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(children[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(children.length, 1);
  children[0].exitCode = 0;
  children[0].emit('exit', 0, 'SIGKILL');
  await restarting;
  assert.equal(children.length, 2);
});

test('systemd adapter uses only the fixed unit', async () => {
  const calls = [];
  const runtime = new SystemdSingBoxRuntime({
    unit: 'vpn-gateway-sing-box.service',
    health: {},
    execFile: async (command, args, options) => calls.push({ command, args, options }),
    probe: async () => true,
  });
  await runtime.restart();
  await runtime.probe();
  assert.equal(calls[0].command, '/usr/bin/systemctl');
  assert.deepEqual(calls[0].args, ['--no-ask-password', 'restart', 'vpn-gateway-sing-box.service']);
  assert.equal(calls[0].options.timeout, 45_000);
  assert.deepEqual(calls[1].args, ['is-active', '--quiet', 'vpn-gateway-sing-box.service']);
});
