import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { promisify } from 'node:util';
import { probeSocksConnect } from './health-probe.js';
import { probeWebSocketUpgrade } from './websocket-probe.js';

const execFileAsync = promisify(execFileCallback);

const delay = (milliseconds) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

export async function validateSingBoxConfig(configPath, {
  singBoxPath = '/usr/local/bin/sing-box',
  execFile = execFileAsync,
  timeoutMs = 15000,
} = {}) {
  try {
    await execFile(singBoxPath, ['check', '-c', configPath], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
  } catch {
    throw new Error('sing-box rejected the candidate configuration');
  }
}

export async function waitForDataPath(health, {
  probe = probeSocksConnect,
  websocketProbe = probeWebSocketUpgrade,
  timeoutMs = 30000,
  attemptTimeoutMs = 3000,
  intervalMs = 250,
  now = Date.now,
  wait = delay,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastError;
  do {
    try {
      await websocketProbe({
        connectHost: health.websocket.connectHost,
        connectPort: health.websocket.connectPort,
        authority: health.websocket.authority,
        path: health.websocket.path,
        timeoutMs: Math.min(attemptTimeoutMs, Math.max(1, deadline - now())),
      });
      // Probe all published exits with separate authenticated SOCKS identities.
      // Parallel attempts share the same deadline, so adding exits does not
      // multiply the controller's bounded transaction or watchdog timeout.
      const profiles = health.profiles ?? [{ username: health.username, password: health.password }];
      if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 16) {
        throw new Error('invalid health profiles');
      }
      const results = await Promise.allSettled(profiles.map((profile) => probe({
        proxyHost: health.listenHost ?? '127.0.0.1',
        proxyPort: health.listenPort,
        username: profile.username,
        password: profile.password,
        targetHost: health.targetHost,
        targetPort: health.targetPort,
        timeoutMs: Math.min(attemptTimeoutMs, Math.max(1, deadline - now())),
      })));
      if (results.some((result) => result.status === 'rejected')) throw new Error('an exit is unavailable');
      return true;
    } catch (error) {
      lastError = error;
      if (now() >= deadline) break;
      await wait(Math.min(intervalMs, Math.max(1, deadline - now())));
    }
  } while (now() < deadline);
  throw new Error(`sing-box data path did not become ready${lastError ? '' : ' in time'}`);
}

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

export class SystemdSingBoxRuntime {
  constructor({
    health,
    unit = 'vpn-gateway-sing-box.service',
    systemctlPath = '/usr/bin/systemctl',
    execFile = execFileAsync,
    probe = waitForDataPath,
  }) {
    this.health = health;
    this.unit = unit;
    this.systemctlPath = systemctlPath;
    this.execFile = execFile;
    this.probeImpl = probe;
  }

  async restart() {
    try {
      // The unit permits up to 30 seconds for an old process to stop. Keep the
      // client alive beyond that ceiling: terminating systemctl does not cancel
      // the manager job and an overlapping rollback could otherwise race it.
      await this.execFile(this.systemctlPath, ['--no-ask-password', 'restart', this.unit], {
        timeout: 45000,
        maxBuffer: 32 * 1024,
        encoding: 'utf8',
      });
    } catch {
      throw new Error('sing-box restart failed');
    }
  }

  async probe(options = {}) {
    try {
      await this.execFile(this.systemctlPath, ['is-active', '--quiet', this.unit], {
        timeout: 5000,
        maxBuffer: 4096,
      });
    } catch {
      throw new Error('sing-box is not active');
    }
    return this.probeImpl(this.health, options);
  }

  isRunning() {
    return null;
  }
}
