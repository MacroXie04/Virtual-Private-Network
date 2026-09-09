import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { childEnvironment, safeInteger } from './process-settings.js';
const execFileAsync = promisify(execFileCallback);

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
  const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const dataDir = env.DATA_DIR;
  const common = { cwd: appRoot, stdio: ['ignore', 'inherit', 'inherit'] };
  let stopping = false;
  const specs = [
    {
      name: 'subscription',
      file: fileURLToPath(new URL('../../http/subscription-server.js', import.meta.url)),
      uid: safeInteger(env.SUB_UID ?? '11001', 'SUB_UID'),
      gid: safeInteger(env.SUB_GID ?? '11001', 'SUB_GID'),
      childEnv: childEnvironment({
        DATA_DIR: dataDir,
        SUB_HOST: env.SUB_HOST ?? '127.0.0.1',
        SUB_PORT: env.SUB_PORT ?? '8080',
      }),
    },
    {
      name: 'administration',
      file: fileURLToPath(new URL('../../http/admin-server.js', import.meta.url)),
      uid: safeInteger(env.ADMIN_UID ?? '11002', 'ADMIN_UID'),
      gid: safeInteger(env.ADMIN_GID ?? '11002', 'ADMIN_GID'),
      childEnv: childEnvironment({
        CONTROLLER_SOCKET: env.CONTROLLER_SOCKET,
        ADMIN_HOST: env.ADMIN_HOST ?? '127.0.0.1',
        ADMIN_PORT: env.ADMIN_PORT ?? '8081',
        ADMIN_PUBLIC_HOSTNAME: env.ADMIN_PUBLIC_HOSTNAME,
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
