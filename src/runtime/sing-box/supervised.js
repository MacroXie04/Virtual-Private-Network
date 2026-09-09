import { spawn as spawnChild } from 'node:child_process';
import { waitForDataPath } from '../health/readiness.js';

function waitForExit(child, timeoutMs = 5000, killTimeoutMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      timer = setTimeout(() => {
        child.off('exit', finish);
        reject(new Error('sing-box did not exit after SIGKILL'));
      }, killTimeoutMs);
      timer.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}

export class SupervisedSingBoxRuntime {
  constructor({
    configPath,
    health,
    singBoxPath = '/usr/local/bin/sing-box',
    uid,
    gid,
    spawn = spawnChild,
    probe = waitForDataPath,
    onUnexpectedExit = () => {},
    stopTimeoutMs = 5000,
    killTimeoutMs = 2000,
  }) {
    if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 60_000) {
      throw new TypeError('stopTimeoutMs is invalid');
    }
    if (!Number.isSafeInteger(killTimeoutMs) || killTimeoutMs < 1 || killTimeoutMs > 60_000) {
      throw new TypeError('killTimeoutMs is invalid');
    }
    this.configPath = configPath;
    this.health = health;
    this.singBoxPath = singBoxPath;
    this.uid = uid;
    this.gid = gid;
    this.spawn = spawn;
    this.probeImpl = probe;
    this.onUnexpectedExit = onUnexpectedExit;
    this.stopTimeoutMs = stopTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.child = null;
    this.stopping = false;
  }

  async start() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    this.stopping = false;
    const child = this.spawn(this.singBoxPath, ['run', '-c', this.configPath], {
      uid: this.uid,
      gid: this.gid,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    this.child = child;
    child.once('error', () => {
      if (!this.stopping && this.child === child) this.onUnexpectedExit(new Error('sing-box failed to start'));
    });
    child.once('exit', (code, signal) => {
      if (!this.stopping && this.child === child) {
        this.onUnexpectedExit(new Error(`sing-box exited unexpectedly (${signal ?? code ?? 'unknown'})`));
      }
    });
  }

  async stop() {
    const child = this.child;
    this.stopping = true;
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await waitForExit(child, this.stopTimeoutMs, this.killTimeoutMs);
    if (this.child === child) this.child = null;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async probe(options = {}) {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error('sing-box is not running');
    }
    return this.probeImpl(this.health, options);
  }

  isRunning() {
    return Boolean(
      this.child
      && this.child.exitCode === null
      && this.child.signalCode === null,
    );
  }
}
