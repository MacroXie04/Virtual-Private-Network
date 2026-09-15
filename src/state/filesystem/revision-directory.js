import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, rmdir, unlink } from 'node:fs/promises';
import {
  REVISION_DIRECTORY_MODE,
  STAGING_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  RUNTIME_FILE_MODE,
  SUBSCRIPTION_FILE_MODE,
  NOFOLLOW,
  DIRECTORY,
  SERVICE_UID,
  PRIVATE_GID,
  REVISION_ID,
  REVISION_FILES,
  RepositoryError,
} from './policy.js';
import { inspectOwnedDirectory, isMissing, safeLstat } from './files.js';

export async function inspectKnownRevisionFiles(directoryPath, {
  ownerUid = SERVICE_UID,
  ownerGid = PRIVATE_GID,
  runtimeGid = ownerGid,
  subscriptionGid = ownerGid,
} = {}) {
  const directoryStat = await safeLstat(directoryPath);
  if (directoryStat === null) return null;
  let handle;
  let bytes = 0;
  try {
    handle = await open(directoryPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.uid !== ownerUid
      || opened.gid !== ownerGid
      || opened.dev !== directoryStat.dev
      || opened.ino !== directoryStat.ino
      || ![STAGING_DIRECTORY_MODE, REVISION_DIRECTORY_MODE].includes(opened.mode & 0o777)
    ) {
      throw new RepositoryError('UNSAFE_PATH', 'temporary revision directory is unsafe');
    }
    const entries = await readdir(directoryPath, { withFileTypes: true });
    if (entries.some((entry) => !REVISION_FILES.includes(entry.name))) {
      throw new RepositoryError('UNSAFE_PATH', 'temporary revision contains an unexpected entry');
    }
    for (const entry of entries) {
      const filePath = path.join(directoryPath, entry.name);
      const stat = await lstat(filePath);
      const expectedGid = entry.name === 'sing-box.json'
        ? runtimeGid
        : entry.name === 'subscription-view.json'
          ? subscriptionGid
          : ownerGid;
      const expectedMode = entry.name === 'sing-box.json'
        ? RUNTIME_FILE_MODE
        : entry.name === 'subscription-view.json'
          ? SUBSCRIPTION_FILE_MODE
          : PRIVATE_FILE_MODE;
      if (
        stat.isSymbolicLink()
        || !stat.isFile()
        || stat.nlink !== 1
        || stat.uid !== ownerUid
        || stat.gid !== expectedGid
        || (stat.mode & 0o777) !== expectedMode
      ) {
        throw new RepositoryError('UNSAFE_PATH', 'temporary revision contains an unsafe entry');
      }
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes)) {
        throw new RepositoryError('UNSAFE_PATH', 'staging revision size is invalid');
      }
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError('UNSAFE_PATH', 'temporary revision could not be inspected safely');
  } finally {
    await handle?.close().catch(() => {});
  }
  return { bytes, mtimeMs: directoryStat.mtimeMs };
}

export async function removeKnownRevisionFiles(directoryPath, identity = {}) {
  if (await inspectKnownRevisionFiles(directoryPath, identity) === null) return;
  for (const name of REVISION_FILES) {
    await unlink(path.join(directoryPath, name)).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
  await rmdir(directoryPath);
}

export function revisionPath(repository, id) {
  if (typeof id !== 'string' || !REVISION_ID.test(id)) {
    throw new RepositoryError('INVALID_REVISION_ID', 'revision id is invalid');
  }
  return path.join(repository.revisionsPath, id);
}

export async function assertRevisionDirectory(repository, id) {
  const revisionPath = repository.revisionPath(id);
  const owner = { ownerUid: repository.ownerUid, ownerGid: repository.ownerGid };
  await inspectOwnedDirectory(repository.root, owner);
  await inspectOwnedDirectory(repository.revisionsPath, owner);
  const stat = await safeLstat(revisionPath);
  if (stat === null) throw new RepositoryError('REVISION_NOT_FOUND', 'revision does not exist');
  let handle;
  try {
    handle = await open(revisionPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.uid !== repository.ownerUid
      || opened.gid !== repository.ownerGid
      || (opened.mode & 0o777) !== REVISION_DIRECTORY_MODE
      || opened.dev !== stat.dev
      || opened.ino !== stat.ino
    ) {
      throw new RepositoryError('INVALID_REVISION', 'revision directory ownership or permissions are unsafe');
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError('INVALID_REVISION', 'revision directory could not be opened safely');
  } finally {
    await handle?.close().catch(() => {});
  }
  return revisionPath;
}

export async function revisionUsage(repository, id) {
  const revisionPath = await repository.assertRevisionDirectory(id);
  const entries = await readdir(revisionPath, { withFileTypes: true });
  if (entries.some((entry) => !REVISION_FILES.includes(entry.name))) {
    throw new RepositoryError('INVALID_REVISION', 'revision directory contains an unexpected entry');
  }
  let bytes = 0;
  for (const entry of entries) {
    const stat = await lstat(path.join(revisionPath, entry.name));
    const expectedGid = entry.name === 'sing-box.json'
      ? repository.runtimeGid ?? repository.ownerGid
      : entry.name === 'subscription-view.json'
        ? repository.subscriptionGid ?? repository.ownerGid
        : repository.ownerGid;
    const expectedMode = entry.name === 'sing-box.json'
      ? RUNTIME_FILE_MODE
      : entry.name === 'subscription-view.json'
        ? SUBSCRIPTION_FILE_MODE
        : PRIVATE_FILE_MODE;
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.nlink !== 1
      || stat.uid !== repository.ownerUid
      || stat.gid !== expectedGid
      || (stat.mode & 0o777) !== expectedMode
    ) {
      throw new RepositoryError('INVALID_REVISION', 'revision directory contains an unsafe entry');
    }
    bytes += stat.size;
    if (!Number.isSafeInteger(bytes)) {
      throw new RepositoryError('INVALID_REVISION', 'revision size is invalid');
    }
  }
  return { id, path: revisionPath, bytes };
}
