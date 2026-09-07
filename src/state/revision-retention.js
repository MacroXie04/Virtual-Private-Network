import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, rename } from 'node:fs/promises';
import { expectInteger } from '../core/validation.js';
import {
  ROOT_MODE,
  REVISION_ID,
  STAGING_ID,
  REMOVAL_ID,
  STAGING_STALE_MS,
  RepositoryError,
} from './repository-policy.js';
import { safeLstat, syncDirectory, ensureOwnedDirectory } from './repository-files.js';
import { inspectKnownRevisionFiles, removeKnownRevisionFiles } from './revision-directory.js';

export async function ensure(repository) {
  const owner = { ownerUid: repository.ownerUid, ownerGid: repository.ownerGid };
  await ensureOwnedDirectory(repository.root, ROOT_MODE, { create: true, ...owner });
  await ensureOwnedDirectory(repository.revisionsPath, ROOT_MODE, { create: true, ...owner });
  const entries = await readdir(repository.revisionsPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!STAGING_ID.test(entry.name) && !REMOVAL_ID.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new RepositoryError('UNSAFE_PATH', 'temporary revision entry is unsafe');
    }
    const temporaryPath = path.join(repository.revisionsPath, entry.name);
    const identity = {
      ...owner,
      runtimeGid: repository.runtimeGid ?? repository.ownerGid,
      subscriptionGid: repository.subscriptionGid ?? repository.ownerGid,
    };
    const usage = await inspectKnownRevisionFiles(temporaryPath, identity);
    if (usage !== null && (
      REMOVAL_ID.test(entry.name)
      || Date.now() - usage.mtimeMs >= STAGING_STALE_MS
    )) {
      await removeKnownRevisionFiles(temporaryPath, identity);
    }
  }
  await syncDirectory(repository.root);
  await syncDirectory(repository.revisionsPath);
  return repository;
}

/**
 * Run only under the deployment's exclusive startup authority. Ordinary
 * ensure() retains recent staging directories to avoid racing active writers;
 * startup may remove all safely shaped staging and deletion tombstones.
 */
export async function cleanupInterruptedWrites(repository) {
  await repository.ensure();
  const entries = await readdir(repository.revisionsPath, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!STAGING_ID.test(entry.name) && !REMOVAL_ID.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new RepositoryError('UNSAFE_PATH', 'temporary revision entry is unsafe');
    }
    await removeKnownRevisionFiles(path.join(repository.revisionsPath, entry.name), {
      ownerUid: repository.ownerUid,
      ownerGid: repository.ownerGid,
      runtimeGid: repository.runtimeGid ?? repository.ownerGid,
      subscriptionGid: repository.subscriptionGid ?? repository.ownerGid,
    });
    removed += 1;
  }
  if (removed > 0) await syncDirectory(repository.revisionsPath);
  return removed;
}

export async function listRevisions(repository) {
  await repository.ensure();
  const entries = await readdir(repository.revisionsPath, { withFileTypes: true });
  const ids = entries
    .filter((entry) => REVISION_ID.test(entry.name))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new RepositoryError('INVALID_REVISION', 'revision entry is unsafe');
      }
      return entry.name;
    })
    .sort();
  return Promise.all(ids.map((id) => repository.revisionUsage(id)));
}

export async function removeRevision(repository, id) {
  const [currentId, runtimeId] = await Promise.all([
    repository.readPointer('current'),
    repository.readPointer('runtime'),
  ]);
  if (id === currentId || id === runtimeId) return false;
  const revisionPath = repository.revisionPath(id);
  const stat = await safeLstat(revisionPath);
  if (stat === null) return false;
  await repository.revisionUsage(id);
  // Recheck protection immediately before the irreversible namespace change.
  // Controller mutations are serialized, and this second check also prevents
  // an accidental direct caller from deleting a newly activated revision.
  const [latestCurrentId, latestRuntimeId] = await Promise.all([
    repository.readPointer('current'),
    repository.readPointer('runtime'),
  ]);
  if (id === latestCurrentId || id === latestRuntimeId) return false;
  const removalPath = path.join(repository.revisionsPath, `.remove-${id}-${randomUUID()}`);
  await rename(revisionPath, removalPath);
  // Once renamed, normal readers can only observe a complete revision or no
  // revision at all. A crash during the following unlink sequence leaves a
  // safely shaped tombstone that ensure() removes on its next invocation.
  await syncDirectory(repository.revisionsPath);
  await removeKnownRevisionFiles(removalPath, {
    ownerUid: repository.ownerUid,
    ownerGid: repository.ownerGid,
    runtimeGid: repository.runtimeGid ?? repository.ownerGid,
    subscriptionGid: repository.subscriptionGid ?? repository.ownerGid,
  });
  await syncDirectory(repository.revisionsPath);
  return true;
}

export async function pruneRevisions(repository, { reserveCount = 0, reserveBytes = 0 } = {}) {
  expectInteger(reserveCount, 'reserveCount', { min: 0, max: 1 });
  expectInteger(reserveBytes, 'reserveBytes', { min: 0, max: repository.maxRevisionBytes });
  const [records, currentId, runtimeId, rootEntries] = await Promise.all([
    repository.listRevisions(),
    repository.readPointer('current'),
    repository.readPointer('runtime'),
    readdir(repository.revisionsPath, { withFileTypes: true }),
  ]);
  const staging = [];
  for (const entry of rootEntries) {
    if (!STAGING_ID.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new RepositoryError('UNSAFE_PATH', 'staging revision entry is unsafe');
    }
    const usage = await inspectKnownRevisionFiles(path.join(repository.revisionsPath, entry.name), {
      ownerUid: repository.ownerUid,
      ownerGid: repository.ownerGid,
      runtimeGid: repository.runtimeGid ?? repository.ownerGid,
      subscriptionGid: repository.subscriptionGid ?? repository.ownerGid,
    });
    if (usage !== null) staging.push(usage);
  }
  const protectedIds = new Set([currentId, runtimeId].filter(Boolean));
  let count = records.length + staging.length;
  let bytes = records.reduce((sum, record) => sum + record.bytes, 0)
    + staging.reduce((sum, record) => sum + record.bytes, 0);
  const removed = [];
  for (const record of records) {
    if (
      count + reserveCount <= repository.maxRevisions
      && bytes + reserveBytes <= repository.maxRevisionBytes
    ) break;
    if (protectedIds.has(record.id)) continue;
    if (await repository.removeRevision(record.id)) {
      count -= 1;
      bytes -= record.bytes;
      removed.push(record.id);
    }
  }
  if (
    count + reserveCount > repository.maxRevisions
    || bytes + reserveBytes > repository.maxRevisionBytes
  ) {
    throw new RepositoryError(
      'REVISION_QUOTA',
      'protected revisions exceed the repository retention budget',
    );
  }
  return Object.freeze({ count, bytes, removed: Object.freeze(removed) });
}
