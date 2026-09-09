import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { absolutePath, safeLstat, syncDirectory } from './secrets/files.js';
import { BootstrapError } from './errors.js';
import { inspectOwnedDirectory } from '../filesystem/files.js';

const NOFOLLOW = fsConstants.O_NOFOLLOW;
const DIRECTORY = fsConstants.O_DIRECTORY;
const BOOTSTRAP_CONFIG_ID = /^\.bootstrap-config-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;
const PERSISTED_REVISION_ID = /^[0-9]{16}-[0-9a-f]{16}$/u;

export async function assertSupportedDataDirectory(dataDir) {
  const normalizedDirectory = absolutePath(dataDir, 'DATA_DIR');
  if (!await inspectOwnedDirectory(normalizedDirectory)) return;
  if (await safeLstat(path.join(normalizedDirectory, '.legacy-migration-in-progress')) !== null) {
    throw new BootstrapError('UNSUPPORTED_DATA', 'unfinished conversion data is unsupported');
  }
  await inspectOwnedDirectory(path.join(normalizedDirectory, 'revisions'));
  const current = await safeLstat(path.join(normalizedDirectory, 'current'));
  const runtime = await safeLstat(path.join(normalizedDirectory, 'runtime'));
  if (current !== null || runtime !== null) return;
  for (const name of ['env', 'config.json', 'tsnet']) {
    if (await safeLstat(path.join(normalizedDirectory, name)) !== null) {
      throw new BootstrapError('UNSUPPORTED_DATA', 'existing data uses an unsupported layout; use a new data directory');
    }
  }
}

export async function cleanupBootstrapConfigOrphans(dataDir) {
  const normalizedDirectory = absolutePath(dataDir, 'DATA_DIR');
  const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
  let directoryHandle;
  let entries;
  try {
    const before = await lstat(normalizedDirectory);
    directoryHandle = await open(normalizedDirectory, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const opened = await directoryHandle.stat();
    if (
      !opened.isDirectory()
      || opened.uid !== expectedUid
      || (opened.mode & 0o022) !== 0
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new BootstrapError('UNSAFE_FILE', 'bootstrap data directory is unsafe');
    }
    entries = await readdir(normalizedDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError('UNSAFE_FILE', 'bootstrap data directory could not be inspected safely');
  } finally {
    await directoryHandle?.close().catch(() => {});
  }

  let removed = 0;
  for (const entry of entries) {
    if (!BOOTSTRAP_CONFIG_ID.test(entry.name)) continue;
    const candidatePath = path.join(normalizedDirectory, entry.name);
    let handle;
    try {
      const before = await lstat(candidatePath);
      handle = await open(candidatePath, fsConstants.O_RDONLY | NOFOLLOW);
      const stat = await handle.stat();
      if (
        !entry.isFile()
        || !stat.isFile()
        || stat.nlink !== 1
        || stat.uid !== expectedUid
        || (stat.mode & 0o777) !== 0o600
        || stat.size > 4 * 1024 * 1024
        || stat.dev !== before.dev
        || stat.ino !== before.ino
      ) {
        throw new BootstrapError('UNSAFE_FILE', 'crash-orphaned bootstrap configuration is unsafe');
      }
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      throw new BootstrapError('UNSAFE_FILE', 'crash-orphaned bootstrap configuration could not be inspected safely');
    } finally {
      await handle?.close().catch(() => {});
    }
    await unlink(candidatePath);
    removed += 1;
  }
  if (removed > 0) await syncDirectory(normalizedDirectory);
  return removed;
}

export async function assertNoUnpointedRevision(dataDir) {
  const normalizedDirectory = absolutePath(dataDir, 'DATA_DIR');
  const revisionsPath = path.join(normalizedDirectory, 'revisions');
  const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
  const before = await safeLstat(revisionsPath);
  if (before === null) return;

  let handle;
  try {
    handle = await open(revisionsPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.uid !== expectedUid
      || (opened.mode & 0o022) !== 0
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new BootstrapError('UNSAFE_FILE', 'revision directory is unsafe');
    }
    const entries = await readdir(revisionsPath, { withFileTypes: true });
    const after = await lstat(revisionsPath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || !after.isDirectory()) {
      throw new BootstrapError('UNSAFE_FILE', 'revision directory changed while being inspected');
    }
    if (entries.some((entry) => PERSISTED_REVISION_ID.test(entry.name))) {
      throw new BootstrapError(
        'ORPHANED_REVISION',
        'committed revisions exist without an authoritative pointer; restore a verified current or runtime pointer from backup',
      );
    }
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError('UNSAFE_FILE', 'revision directory could not be inspected safely');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function resumeExistingBootstrap({ repo, dataDir }) {
  const statePointerPresent = (await safeLstat(path.join(dataDir, 'current'))) !== null
    || (await safeLstat(path.join(dataDir, 'runtime'))) !== null;
  if (!statePointerPresent) return null;

  const current = await repo.readCurrent();
  if (current !== null) {
    const runtimeId = await repo.readPointer('runtime');
    if (runtimeId !== null) await repo.assertSupportedRevisionSchema(runtimeId);
    await repo.cleanupInterruptedWrites?.();
    await cleanupBootstrapConfigOrphans(dataDir);
    if (runtimeId !== current.id) await repo.activateRuntime(current.id);
    return Object.freeze({
      status: runtimeId === current.id ? 'existing' : 'recovered',
      id: current.id,
      revision: current.state.revision,
    });
  }
  const runtime = await repo.readRuntime();
  if (runtime === null) return null;
  if (runtime.manifest.operation === 'ingress.migrate') {
    throw new BootstrapError('UNSUPPORTED_DATA', 'uncommitted conversion data is unsupported');
  }
  await repo.activateCurrent(runtime.id);
  await repo.cleanupInterruptedWrites?.();
  await cleanupBootstrapConfigOrphans(dataDir);
  return Object.freeze({
    status: 'recovered',
    id: runtime.id,
    revision: runtime.state.revision,
  });
}
