import { constants as fsConstants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { ControllerError } from '../requests/contract.js';

const NOFOLLOW = fsConstants.O_NOFOLLOW;
const MAX_AUDIT_BYTES = 1024 * 1024;
const CONTROLLER_UID = process.geteuid?.() ?? process.getuid?.() ?? 0;
const CONTROLLER_GID = CONTROLLER_UID === 0
  ? 0
  : process.getegid?.() ?? process.getgid?.() ?? 0;

async function normalizePrivateHandle(handle, description) {
  let stat = await handle.stat();
  if (
    !stat.isFile()
    || stat.nlink !== 1
    || stat.uid !== CONTROLLER_UID
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(`unsafe ${description}`);
  }
  if (stat.gid !== CONTROLLER_GID) await handle.chown(CONTROLLER_UID, CONTROLLER_GID);
  stat = await handle.stat();
  if (
    !stat.isFile()
    || stat.nlink !== 1
    || stat.uid !== CONTROLLER_UID
    || stat.gid !== CONTROLLER_GID
    || (stat.mode & 0o777) !== 0o600
  ) throw new Error(`unsafe ${description}`);
  return stat;
}

export async function setMaintenance(controller, active) {
  if (!active) {
    await unlink(controller.maintenancePath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    return;
  }
  let handle;
  try {
    handle = await open(
      controller.maintenancePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await normalizePrivateHandle(handle, 'maintenance marker');
    await handle.writeFile(`${controller.timestamp()}\n`);
    await handle.sync();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existing;
    try {
      existing = await open(controller.maintenancePath, fsConstants.O_RDONLY | NOFOLLOW);
      await normalizePrivateHandle(existing, 'maintenance marker');
    } finally {
      await existing?.close().catch(() => {});
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function assertOuterTransactionCommitted(controller) {
  for (const markerPath of controller.outerTransactionPaths) {
    try {
      await lstat(markerPath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new ControllerError('STATE_UNAVAILABLE', 503);
    }
    // The bare installer retains these durable markers until its external
    // Tunnel/origin checks and transaction commit complete. Repository
    // writes in that window could either create descendants that cannot be
    // attributed safely on resume or be silently lost during rollback.
    throw new ControllerError('DEPLOYMENT_NOT_COMMITTED', 503);
  }
}

export async function appendAudit(controller, { operation, revision, userId = null, outcome = 'committed' }) {
  const event = Buffer.from(`${JSON.stringify({
    timestamp: controller.timestamp(),
    operation,
    revision,
    userId,
    outcome,
  })}\n`, 'utf8');
  const previousPath = `${controller.auditPath}.previous`;
  let handle;
  try {
    handle = await open(
      controller.auditPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | NOFOLLOW,
      0o600,
    );
    let stat = await normalizePrivateHandle(handle, 'audit path');
    if (stat.size + event.length > MAX_AUDIT_BYTES) {
      await handle.close();
      handle = null;
      const previous = await lstat(previousPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (previous !== null) {
        if (
          !previous.isFile()
          || previous.isSymbolicLink()
          || previous.nlink !== 1
          || previous.uid !== CONTROLLER_UID
          || previous.gid !== CONTROLLER_GID
          || (previous.mode & 0o777) !== 0o600
        ) {
          throw new Error('unsafe rotated audit path');
        }
        await unlink(previousPath);
      }
      await rename(controller.auditPath, previousPath);
      handle = await open(
        controller.auditPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
        0o600,
      );
      stat = await normalizePrivateHandle(handle, 'audit path');
    }
    await handle.writeFile(event);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}
