import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readlink, rename, symlink, unlink } from 'node:fs/promises';
import { POINTER_NAMES, RepositoryError } from './repository-policy.js';
import { isMissing, safeLstat, syncDirectory } from './repository-files.js';

export async function readPointer(repository, name) {
  if (!POINTER_NAMES.has(name)) throw new TypeError('pointer name is invalid');
  await repository.ensure();
  const pointerPath = path.join(repository.root, name);
  const stat = await safeLstat(pointerPath);
  if (stat === null) return null;
  if (!stat.isSymbolicLink() || stat.uid !== repository.ownerUid) {
    throw new RepositoryError('UNSAFE_POINTER', 'repository pointer ownership or type is unsafe');
  }
  const target = await readlink(pointerPath);
  const prefix = 'revisions/';
  if (!target.startsWith(prefix) || target.includes('\\') || path.posix.normalize(target) !== target) {
    throw new RepositoryError('UNSAFE_POINTER', 'repository pointer target is invalid');
  }
  const id = target.slice(prefix.length);
  await repository.assertRevisionDirectory(id);
  return id;
}

export async function swapPointer(repository, name, id) {
  if (!POINTER_NAMES.has(name)) throw new TypeError('pointer name is invalid');
  await repository.ensure();
  await repository.assertRevisionDirectory(id);
  const pointerPath = path.join(repository.root, name);
  const existing = await safeLstat(pointerPath);
  if (existing !== null && (!existing.isSymbolicLink() || existing.uid !== repository.ownerUid)) {
    throw new RepositoryError('UNSAFE_POINTER', 'repository pointer ownership or type is unsafe');
  }
  const temporaryPath = path.join(repository.root, `.${name}-${randomUUID()}`);
  try {
    await symlink(`revisions/${id}`, temporaryPath, 'dir');
    await rename(temporaryPath, pointerPath);
    await syncDirectory(repository.root);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
  return id;
}

export async function initialize(repository, value, options) {
  await repository.ensure();
  const [currentId, runtimeId] = await Promise.all([
    repository.readPointer('current'),
    repository.readPointer('runtime'),
  ]);
  if (currentId !== null || runtimeId !== null) {
    // Finish only the two possible interrupted initialization states. Once a
    // current pointer exists it is authoritative; a later controller recovery
    // will deliberately reconcile any runtime mismatch.
    if (currentId === null && runtimeId !== null) {
      const recovered = await repository.readRevision(runtimeId);
      await repository.activateCurrent(runtimeId);
      return Object.freeze({
        id: recovered.id,
        revision: recovered.state.revision,
        path: recovered.path,
        manifest: recovered.manifest,
      });
    }
    if (currentId !== null && runtimeId === null) {
      const recovered = await repository.readRevision(currentId);
      await repository.activateRuntime(currentId);
      return Object.freeze({
        id: recovered.id,
        revision: recovered.state.revision,
        path: recovered.path,
        manifest: recovered.manifest,
      });
    }
    throw new RepositoryError('ALREADY_INITIALIZED', 'repository pointers already exist');
  }
  const revision = await repository.createRevision(value, options);
  await repository.activateRuntime(revision.id);
  await repository.activateCurrent(revision.id);
  return revision;
}
