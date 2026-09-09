import { createApplicationLifecycle } from './lifecycle.js';
import { spawn as spawnChild } from 'node:child_process';
import path from 'node:path';
import { readSecretFile } from '../../state/bootstrap/secrets/files.js';
import { assertSupportedDataDirectory } from '../../state/bootstrap/recovery.js';
import { GatewayController } from '../authority/controller.js';
import { RevisionRepository } from '../../state/repository.js';
import { buildRuntimeHealth } from '../../core/server/render.js';
import { SupervisedSingBoxRuntime } from '../../runtime/sing-box/supervised.js';
import { SystemdSingBoxRuntime } from '../../runtime/sing-box/systemd.js';
import { validateSingBoxConfig } from '../../runtime/sing-box/config-check.js';
import { validatePublicDnsHostname } from '../../core/validation/ingress.js';
import { absolutePath, safeInteger } from './process-settings.js';
import { createControlSocketService } from '../socket/server.js';
import { spawnWebProcesses, notifyServiceReady } from './web-processes.js';

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
  await assertSupportedDataDirectory(dataDir);
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
  });
  const current = await repo.readCurrent();
  if (!current) throw new Error('VPN gateway is not initialized');
  const runtimeId = await repo.readPointer('runtime');
  if (runtimeId && runtimeId !== current.id) await repo.assertSupportedRevisionSchema(runtimeId);
  const operationalState = current.state;
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
  const lifecycle = createApplicationLifecycle({
    authority, runtimeAdapter, control, supervise, notifyReady,
    watchdogIntervalMs, setWatchdogTimeout, clearWatchdogTimeout,
    startWeb: (onUnexpectedExit) => spawnWebProcesses({
      env: {
        ...env,
        DATA_DIR: dataDir,
        CONTROLLER_SOCKET: socketPath,
        ADMIN_PUBLIC_HOSTNAME: adminPublicHostname,
      },
      spawn,
      onUnexpectedExit,
    }),
  });
  fatal = lifecycle.fatal;
  return lifecycle.application;
}
