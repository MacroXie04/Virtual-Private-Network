import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  open,
  unlink,
} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readSecretFile } from './bootstrap.js';
import { GatewayController } from './controller.js';
import { RevisionRepository } from './repository.js';
import {
  SupervisedSingBoxRuntime,
  SystemdSingBoxRuntime,
  validateSingBoxConfig,
} from './runtime.js';
import { validateAbsoluteStatePath } from './validation.js';

const NOFOLLOW = fsConstants.O_NOFOLLOW;
const execFileAsync = promisify(execFileCallback);
export const MAX_CONTROL_REQUEST_BYTES = 64 * 1024;
export const MAX_CONTROL_RESPONSE_BYTES = 512 * 1024;
const GENERIC_CONTROL_MESSAGE = 'Controller request failed';

function safeInteger(value, name, { min = 0, max = 2_147_483_647 } = {}) {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
    throw new TypeError(`${name} is invalid`);
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

function absolutePath(value, name) {
  const result = validateAbsoluteStatePath(value, name);
  if (path.normalize(result) !== result) throw new TypeError(`${name} must be normalized`);
  return result;
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/u.test(value) ? value : null;
}

function errorRecord(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(error.code)
    ? error.code
    : 'INTERNAL';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  return { code, message: GENERIC_CONTROL_MESSAGE, status };
}

function responseLine(value, maxBytes) {
  let line;
  try {
    line = `${JSON.stringify(value)}\n`;
  } catch {
    line = `{"id":null,"ok":false,"error":{"code":"INTERNAL","message":"${GENERIC_CONTROL_MESSAGE}","status":500}}\n`;
  }
  if (Buffer.byteLength(line) > maxBytes) {
    return `{"id":null,"ok":false,"error":{"code":"RESPONSE_TOO_LARGE","message":"${GENERIC_CONTROL_MESSAGE}","status":500}}\n`;
  }
  return line;
}

async function assertSocketDirectory(socketPath, ownerUid) {
  const directory = path.dirname(socketPath);
  const stat = await lstat(directory);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || (stat.mode & 0o022) !== 0
    || (ownerUid !== null && stat.uid !== ownerUid)
  ) {
    throw new Error('controller socket directory is unsafe');
  }
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | NOFOLLOW);
    await handle.stat();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertSocketPathAbsent(socketPath) {
  try {
    await lstat(socketPath);
    // Never remove this path here: doing so could detach a live controller and
    // create two independent authorities. The deployment lifecycle owns stale
    // socket cleanup before it launches this process.
    throw new Error('controller socket path already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * Bounded, one-request-per-connection NDJSON server. Filesystem permissions on
 * the Unix socket are the transport authentication boundary.
 */
export function createControlSocketService({
  controller,
  socketPath,
  socketUid = null,
  socketGid = null,
  socketMode = 0o660,
  timeoutMs = 10_000,
  maxRequestBytes = MAX_CONTROL_REQUEST_BYTES,
  maxResponseBytes = MAX_CONTROL_RESPONSE_BYTES,
  maxConnections = 32,
} = {}) {
  if (!controller || typeof controller.dispatch !== 'function') throw new TypeError('controller is required');
  const normalizedSocketPath = absolutePath(socketPath, 'CONTROLLER_SOCKET');
  for (const [name, value, minimum, maximum] of [
    ['timeoutMs', timeoutMs, 100, 60_000],
    ['maxRequestBytes', maxRequestBytes, 256, 1024 * 1024],
    ['maxResponseBytes', maxResponseBytes, 256, 1024 * 1024],
    ['maxConnections', maxConnections, 1, 1024],
  ]) safeInteger(value, name, { min: minimum, max: maximum });
  if (socketUid !== null) safeInteger(socketUid, 'socketUid');
  if (socketGid !== null) safeInteger(socketGid, 'socketGid');
  if (!Number.isInteger(socketMode) || socketMode < 0o600 || socketMode > 0o770) {
    throw new TypeError('socketMode is invalid');
  }

  const sockets = new Set();
  const dispatchedSockets = new Set();
  let closing = false;
  let boundIdentity = null;
  let serviceClosePromise = null;
  const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: false }, (socket) => {
    sockets.add(socket);
    socket.setTimeout(timeoutMs);
    socket.setNoDelay(true);
    let received = Buffer.alloc(0);
    let handled = false;

    const finish = (value) => {
      if (socket.destroyed) return;
      socket.end(responseLine(value, maxResponseBytes));
    };
    const reject = (id = null, code = 'INVALID', status = 400) => {
      if (handled) return;
      handled = true;
      finish({ id, ok: false, error: { code, message: GENERIC_CONTROL_MESSAGE, status } });
    };

    socket.on('data', (chunk) => {
      if (handled || closing) {
        socket.destroy();
        return;
      }
      if (received.length + chunk.length > maxRequestBytes) {
        reject(null, 'REQUEST_TOO_LARGE', 400);
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      if (received.subarray(newline + 1).toString('utf8').trim() !== '') {
        reject();
        return;
      }
      handled = true;
      socket.pause();
      socket.setTimeout(0);
      let request;
      try {
        request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(received.subarray(0, newline)));
      } catch {
        finish({ id: null, ok: false, error: { code: 'INVALID', message: GENERIC_CONTROL_MESSAGE, status: 400 } });
        return;
      }
      const id = safeRequestId(request?.id);
      if (!plainObject(request) || id === null) {
        finish({ id, ok: false, error: { code: 'INVALID', message: GENERIC_CONTROL_MESSAGE, status: 400 } });
        return;
      }
      dispatchedSockets.add(socket);
      Promise.resolve().then(() => controller.dispatch(request)).then(
        (result) => finish({ id, ok: true, result }),
        (error) => finish({ id, ok: false, error: errorRecord(error) }),
      );
    });
    socket.once('timeout', () => reject(null, 'TIMEOUT', 408));
    socket.once('error', () => {});
    socket.once('close', () => {
      sockets.delete(socket);
      dispatchedSockets.delete(socket);
    });
  });
  server.maxConnections = maxConnections;

  return {
    server,
    socketPath: normalizedSocketPath,
    async listen() {
      if (closing) throw new Error('controller socket service is closing');
      if (server.listening) return;
      await assertSocketDirectory(normalizedSocketPath, socketUid);
      await assertSocketPathAbsent(normalizedSocketPath);
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(normalizedSocketPath);
        });
        const initialStat = await lstat(normalizedSocketPath);
        if (!initialStat.isSocket()) throw new Error('controller socket path is unsafe');
        boundIdentity = { dev: initialStat.dev, ino: initialStat.ino };
        if (socketUid !== null || socketGid !== null) {
          await chown(normalizedSocketPath, socketUid ?? -1, socketGid ?? -1);
        }
        await chmod(normalizedSocketPath, socketMode);
        const stat = await lstat(normalizedSocketPath);
        if (!stat.isSocket() || stat.dev !== boundIdentity.dev || stat.ino !== boundIdentity.ino) {
          throw new Error('controller socket path changed during setup');
        }
      } catch (error) {
        if (server.listening) {
          for (const socket of sockets) socket.destroy();
          await new Promise((resolve) => server.close(resolve));
        }
        const stat = await lstat(normalizedSocketPath).catch(() => null);
        if (stat?.isSocket()
          && boundIdentity !== null
          && stat.dev === boundIdentity.dev
          && stat.ino === boundIdentity.ino) {
          await unlink(normalizedSocketPath).catch(() => {});
        }
        throw error;
      }
    },
    close() {
      if (serviceClosePromise) return serviceClosePromise;
      closing = true;
      serviceClosePromise = (async () => {
        // Drop idle or partially framed peers, but let every fully accepted
        // request send its response. This is essential for create/rotate,
        // whose raw token is intentionally returned exactly once.
        for (const socket of sockets) {
          if (!dispatchedSockets.has(socket)) socket.destroy();
        }
        if (server.listening) {
          await new Promise((resolve) => server.close(resolve));
        }
        const stat = await lstat(normalizedSocketPath).catch((error) => {
          if (error?.code === 'ENOENT') return null;
          throw error;
        });
        if (stat !== null
          && stat.isSocket()
          && boundIdentity !== null
          && stat.dev === boundIdentity.dev
          && stat.ino === boundIdentity.ino) {
          await unlink(normalizedSocketPath);
        }
        boundIdentity = null;
      })();
      return serviceClosePromise;
    },
  };
}

function childEnvironment(entries) {
  const result = {
    NODE_ENV: 'production',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
  for (const [name, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null && value !== '') result[name] = String(value);
  }
  return result;
}

/** Tell systemd that recovery and control-socket publication are complete. */
export async function notifyServiceReady({ env = process.env, execFile = execFileAsync } = {}) {
  if (typeof env.NOTIFY_SOCKET !== 'string' || env.NOTIFY_SOCKET.length === 0) return false;
  await execFile('/usr/bin/systemd-notify', ['--ready', '--pid=parent'], {
    timeout: 5_000,
    maxBuffer: 4_096,
    env: { NOTIFY_SOCKET: env.NOTIFY_SOCKET },
  });
  return true;
}

function stopChild(child, timeoutMs = 5_000, killTimeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const force = () => {
      child.kill('SIGKILL');
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.off('exit', finish);
        reject(new Error('web process did not exit after SIGKILL'));
      }, killTimeoutMs);
      timer.unref?.();
    };
    timer = setTimeout(force, timeoutMs);
    timer.unref?.();
    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}

export function spawnWebProcesses({
  env,
  spawn = spawnChild,
  onUnexpectedExit = () => {},
} = {}) {
  const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataDir = env.DATA_DIR;
  const common = { cwd: appRoot, stdio: ['ignore', 'inherit', 'inherit'] };
  let stopping = false;
  const specs = [
    {
      name: 'subscription',
      file: path.join(appRoot, 'src', 'subscription-server.js'),
      uid: safeInteger(env.SUB_UID ?? '11001', 'SUB_UID'),
      gid: safeInteger(env.SUB_GID ?? '11001', 'SUB_GID'),
      childEnv: childEnvironment({
        DATA_DIR: dataDir,
        SUB_HOST: env.SUB_HOST ?? '0.0.0.0',
        SUB_PORT: env.SUB_PORT ?? '8080',
      }),
    },
    {
      name: 'administration',
      file: path.join(appRoot, 'src', 'admin-server.js'),
      uid: safeInteger(env.ADMIN_UID ?? '11002', 'ADMIN_UID'),
      gid: safeInteger(env.ADMIN_GID ?? '11002', 'ADMIN_GID'),
      childEnv: childEnvironment({
        CONTROLLER_SOCKET: env.CONTROLLER_SOCKET,
        ADMIN_HOST: env.ADMIN_HOST ?? '0.0.0.0',
        ADMIN_PORT: env.ADMIN_PORT ?? '8081',
        ADMIN_ALLOWED_HOSTS: env.ADMIN_ALLOWED_HOSTS,
        ADMIN_ALLOWED_ORIGINS: env.ADMIN_ALLOWED_ORIGINS,
      }),
    },
  ];
  const children = [];
  try {
    for (const spec of specs) {
      const child = spawn(process.execPath, [spec.file], {
        ...common,
        uid: spec.uid,
        gid: spec.gid,
        env: spec.childEnv,
      });
      const failed = () => {
        if (!stopping) onUnexpectedExit(new Error(`${spec.name} process stopped unexpectedly`));
      };
      child.once('error', failed);
      child.once('exit', failed);
      children.push(child);
    }
  } catch (error) {
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    throw error;
  }
  return {
    children,
    async stop() {
      stopping = true;
      await Promise.all(children.map((child) => stopChild(child)));
    },
  };
}

/** Probe routed readiness and make publication fail closed on every failure. */
export async function runDataPathWatchdog(authority) {
  try {
    await authority.dispatch({ id: `watchdog-${randomUUID()}`, op: 'health.status' });
    return true;
  } catch {
    authority.markUnready();
    try {
      await authority.setMaintenance(true);
    } catch {
      throw new Error('data-path watchdog could not publish maintenance state');
    }
    return false;
  }
}

export async function createControllerApplication({
  env = process.env,
  spawn = spawnChild,
  repository,
  runtime,
  controller,
  socketUid = 0,
  notifyReady = () => notifyServiceReady({ env }),
  watchdogIntervalMs = 30_000,
  setWatchdogTimeout = setTimeout,
  clearWatchdogTimeout = clearTimeout,
} = {}) {
  const dataDir = absolutePath(env.DATA_DIR ?? '/var/lib/vpn-gateway', 'DATA_DIR');
  const socketPath = absolutePath(
    env.CONTROLLER_SOCKET ?? '/run/vpn-gateway/controller.sock',
    'CONTROLLER_SOCKET',
  );
  const runtimeGid = safeInteger(env.SINGBOX_GID ?? '11000', 'SINGBOX_GID');
  const subscriptionGid = safeInteger(env.SUB_GID ?? '11001', 'SUB_GID');
  const adminGid = safeInteger(env.ADMIN_GID ?? '11002', 'ADMIN_GID');
  const repo = repository ?? new RevisionRepository(dataDir, { runtimeGid, subscriptionGid });
  const current = await repo.readCurrent();
  if (!current) throw new Error('VPN gateway is not initialized');
  if (current.requiresPolicyUpgrade) {
    throw new Error('VPN gateway policy upgrade must complete before services start');
  }
  const health = {
    listenHost: '127.0.0.1',
    listenPort: current.state.health.listenPort,
    username: current.state.health.username,
    password: current.state.health.password,
    targetHost: current.state.health.target.host,
    targetPort: current.state.health.target.port,
  };
  const expectedConfigPath = path.join(dataDir, 'runtime', 'sing-box.json');
  const configuredPath = absolutePath(env.SINGBOX_CONFIG ?? expectedConfigPath, 'SINGBOX_CONFIG');
  if (configuredPath !== expectedConfigPath) {
    throw new TypeError('SINGBOX_CONFIG must address the repository runtime revision');
  }
  if (env.SUPERVISE !== undefined && env.SUPERVISE !== '0' && env.SUPERVISE !== '1') {
    throw new TypeError('SUPERVISE must be 0 or 1');
  }
  safeInteger(watchdogIntervalMs, 'watchdogIntervalMs', { min: 1_000, max: 10 * 60_000 });
  if (typeof setWatchdogTimeout !== 'function' || typeof clearWatchdogTimeout !== 'function') {
    throw new TypeError('watchdog timer functions are required');
  }
  const supervise = env.SUPERVISE === '1';
  let fatal = () => {};
  const runtimeAdapter = runtime ?? (supervise
    ? new SupervisedSingBoxRuntime({
      configPath: configuredPath,
      health,
      singBoxPath: absolutePath(env.SINGBOX_BIN ?? '/usr/local/bin/sing-box', 'SINGBOX_BIN'),
      uid: safeInteger(env.SINGBOX_UID ?? '11000', 'SINGBOX_UID'),
      gid: runtimeGid,
      spawn,
      onUnexpectedExit: (error) => fatal(error),
    })
    : new SystemdSingBoxRuntime({
      health,
      unit: (() => {
        const unit = env.SINGBOX_SERVICE ?? 'vpn-gateway-sing-box.service';
        if (unit !== 'vpn-gateway-sing-box.service') {
          throw new TypeError('SINGBOX_SERVICE must identify the fixed gateway service');
        }
        return unit;
      })(),
    }));
  const authority = controller ?? new GatewayController({
    repository: repo,
    runtime: runtimeAdapter,
    dataDir,
    validateConfig: (configPath) => validateSingBoxConfig(configPath, {
      singBoxPath: absolutePath(env.SINGBOX_BIN ?? '/usr/local/bin/sing-box', 'SINGBOX_BIN'),
    }),
    readExitDirectoryCredential: env.TS_API_KEY_FILE
      ? () => readSecretFile(absolutePath(env.TS_API_KEY_FILE, 'TS_API_KEY_FILE'), {
        description: 'Tailscale API-key file',
      })
      : null,
  });
  const control = createControlSocketService({
    controller: authority,
    socketPath,
    socketUid,
    socketGid: adminGid,
  });
  let web = null;
  let stopping = false;
  let exitCode = 0;
  let startPromise = null;
  let cleanupPromise = null;
  let closePromise = null;
  let watchdogTimer = null;
  let watchdogPromise = Promise.resolve();

  const scheduleWatchdog = () => {
    if (stopping || watchdogTimer !== null) return;
    watchdogTimer = setWatchdogTimeout(() => {
      watchdogTimer = null;
      if (stopping) return;
      watchdogPromise = runDataPathWatchdog(authority)
        .catch(() => {
          // If the maintenance marker itself cannot be made authoritative,
          // stopping the full application is the only fail-closed outcome.
          fatal();
        })
        .finally(() => {
          if (!stopping) scheduleWatchdog();
        });
    }, watchdogIntervalMs);
    watchdogTimer?.unref?.();
  };

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (watchdogTimer !== null) {
        clearWatchdogTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      authority.markUnready();
      await control.close().catch(() => { exitCode = 1; });
      await Promise.allSettled([authority.drain?.(), watchdogPromise]);
      // A watchdog recovery that was already queued may have published
      // readiness while shutdown was beginning. Reassert local unready state
      // after all controller mutations have drained.
      authority.markUnready();
      if (typeof authority.setMaintenance === 'function') {
        await authority.setMaintenance(true).catch(() => { exitCode = 1; });
      }
      authority.sessions?.destroyAll?.();
      await web?.stop().catch(() => { exitCode = 1; });
      if (supervise) await runtimeAdapter.stop().catch(() => { exitCode = 1; });
    })();
    return cleanupPromise;
  };
  const close = (code = 0) => {
    exitCode = Math.max(exitCode, code);
    stopping = true;
    authority.markUnready();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      await cleanup();
    })();
    return closePromise;
  };
  fatal = () => {
    void close(1).finally(() => { process.exitCode = 1; });
  };

  const application = {
    controller: authority,
    runtime: runtimeAdapter,
    control,
    get exitCode() { return exitCode; },
    start() {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        if (stopping) throw new Error('controller startup was interrupted');
        try {
          await authority.recover();
        } catch (error) {
          // Keep the root-owned control socket and loopback administration UI
          // available when the selected exit node cannot establish a routed
          // data path. The maintenance marker remains in place, so public
          // subscriptions stay fail-closed while an administrator selects a
          // different exit node from the freshly validated directory.
          if (error?.code !== 'RUNTIME_UNAVAILABLE') throw error;
        }
        if (stopping) throw new Error('controller startup was interrupted');
        await control.listen();
        if (stopping) throw new Error('controller startup was interrupted');
        if (supervise) {
          web = spawnWebProcesses({ env: { ...env, DATA_DIR: dataDir, CONTROLLER_SOCKET: socketPath }, spawn, onUnexpectedExit: fatal });
          if (stopping) throw new Error('controller startup was interrupted');
        }
        await notifyReady();
        scheduleWatchdog();
      })().catch(async (error) => {
        exitCode = 1;
        stopping = true;
        await cleanup();
        throw error;
      });
      return startPromise;
    },
    close,
  };
  return application;
}

async function main() {
  const app = await createControllerApplication();
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void app.close(0).finally(() => { process.exitCode = app.exitCode; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await app.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('VPN gateway controller failed to start.\n');
    process.exitCode = 1;
  });
}
