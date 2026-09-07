import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import {
  NOFOLLOW,
  DIRECTORY,
  SERVICE_UID,
  PRIVATE_GID,
  RepositoryError,
} from './repository-policy.js';

export function isMissing(error) {
  return error?.code === 'ENOENT';
}

export async function safeLstat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function ensureOwnedDirectory(directoryPath, mode, {
  create = false,
  ownerUid = SERVICE_UID,
  ownerGid = PRIVATE_GID,
} = {}) {
  let stat = await safeLstat(directoryPath);
  if (stat === null && create) {
    try {
      await mkdir(directoryPath, { mode });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    stat = await safeLstat(directoryPath);
  }
  if (stat === null) throw new RepositoryError('UNSAFE_PATH', 'repository directory is missing or unsafe');
  let handle;
  try {
    handle = await open(directoryPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    stat = await handle.stat();
    if (!stat.isDirectory() || stat.uid !== ownerUid) {
      throw new RepositoryError('UNSAFE_PATH', 'repository directory ownership is unsafe');
    }
    if (stat.gid !== ownerGid) await handle.chown(ownerUid, ownerGid);
    await handle.chmod(mode);
    const verified = await handle.stat();
    if (
      verified.dev !== stat.dev
      || verified.ino !== stat.ino
      || verified.uid !== ownerUid
      || verified.gid !== ownerGid
      || (verified.mode & 0o777) !== mode
    ) {
      throw new RepositoryError('UNSAFE_PATH', 'repository directory changed during validation');
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError('UNSAFE_PATH', 'repository directory could not be opened safely');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeExclusive(filePath, bytes, mode, ownerUid, ownerGid) {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      mode,
    );
    // Establish the final owner before writing secret bytes. In particular,
    // never inherit vpn-admin as the group of private root-owned artifacts.
    await handle.chown(ownerUid, ownerGid);
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readNoFollow(filePath, {
  maxBytes,
  expectedMode,
  expectedUid = SERVICE_UID,
  expectedGid = PRIVATE_GID,
}) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || stat.uid !== expectedUid
      || stat.gid !== expectedGid
      || stat.size < 2
      || stat.size > maxBytes
    ) {
      throw new RepositoryError('INVALID_REVISION', 'revision file is not a bounded regular file');
    }
    if ((stat.mode & 0o777) !== expectedMode) {
      throw new RepositoryError('INVALID_REVISION', 'revision file permissions are unsafe');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > maxBytes) {
      throw new RepositoryError('INVALID_REVISION', 'revision file changed while being read');
    }
    return bytes;
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError('INVALID_REVISION', 'revision file could not be read safely');
  } finally {
    await handle?.close().catch(() => {});
  }
}
