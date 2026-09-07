import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readSecretFile } from '../state/bootstrap-files.js';
import { GatewayController } from './controller.js';
import { RevisionRepository } from '../state/repository.js';
import { buildRuntimeHealth } from '../core/server-render.js';
import { SupervisedSingBoxRuntime, SystemdSingBoxRuntime, validateSingBoxConfig } from '../runtime/runtime.js';
import { validatePublicDnsHostname } from '../core/validation.js';
import { absolutePath, safeInteger } from './process-settings.js';
import { createControlSocketService } from './control-socket.js';
import { spawnWebProcesses, notifyServiceReady } from './web-processes.js';

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
  const repo = repository ?? new RevisionRepository(dataDir, {
    runtimeGid,
    subscriptionGid,
    allowLegacyMigration: true,
  });
  const current = await repo.readCurrent();
  if (!current) throw new Error('VPN gateway is not initialized');
  const runtimeRevision = current.requiresIngressMigration ? await repo.readRuntime() : current;
  if (
    !runtimeRevision
    || (current.requiresIngressMigration && (
      runtimeRevision.requiresIngressMigration
      || runtimeRevision.manifest.operation !== 'ingress.migrate'
      || runtimeRevision.state.revision !== current.state.revision + 1
    ))
  ) {
    throw new Error('VPN gateway ingress migration must be staged before services start');
  }
  const operationalState = runtimeRevision.state;
  const adminPublicHostname = validatePublicDnsHostname(
    env.ADMIN_PUBLIC_HOSTNAME,
    'ADMIN_PUBLIC_HOSTNAME',
  );
  if (adminPublicHostname !== operationalState.gateway.adminPublicHostname) {
    throw new TypeError('ADMIN_PUBLIC_HOSTNAME must match canonical gateway state');
  }
  const health = buildRuntimeHealth(operationalState);
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
    readEnrollmentCredential: env.TS_AUTH_KEY_FILE
      ? () => readSecretFile(absolutePath(env.TS_AUTH_KEY_FILE, 'TS_AUTH_KEY_FILE'), {
        description: 'Tailscale enrollment-key file',
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
          web = spawnWebProcesses({
            env: {
              ...env,
              DATA_DIR: dataDir,
              CONTROLLER_SOCKET: socketPath,
              ADMIN_PUBLIC_HOSTNAME: adminPublicHostname,
            },
            spawn,
            onUnexpectedExit: fatal,
          });
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
