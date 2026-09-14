import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
const NOFOLLOW = fsConstants.O_NOFOLLOW;

export async function assertSocketDirectory(socketPath, ownerUid) {
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

export async function assertSocketPathAbsent(socketPath) {
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
