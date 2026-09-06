import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  assertFailClosedConfig,
  buildSubscriptionView,
  renderSingBoxConfig,
} from '../core/render.js';
import { validateLegacyV2Revision } from '../migrations/legacy-v2.js';
import { validateState, validateSubscriptionView } from '../core/state-schema.js';
import { ValidationError, expectInteger, expectString, isPlainObject } from '../core/validation.js';

const ROOT_MODE = 0o751;
const REVISION_DIRECTORY_MODE = 0o751;
const STAGING_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RUNTIME_FILE_MODE = 0o640;
const SUBSCRIPTION_FILE_MODE = 0o640;
const NOFOLLOW = fsConstants.O_NOFOLLOW;
const DIRECTORY = fsConstants.O_DIRECTORY;
const SERVICE_UID = process.geteuid?.() ?? process.getuid?.() ?? 0;
const SERVICE_GID = process.getegid?.() ?? process.getgid?.() ?? 0;
// A root controller may deliberately expose its control socket to vpn-admin,
// but all private repository objects must remain root:root. Non-root test and
// development processes retain their own primary identity.
const PRIVATE_GID = SERVICE_UID === 0 ? 0 : SERVICE_GID;
const REVISION_ID = /^[0-9]{16}-[0-9a-f]{16}$/u;
const STAGING_ID = /^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REMOVAL_ID = /^\.remove-[0-9]{16}-[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const POINTER_NAMES = new Set(['current', 'runtime']);
const REVISION_FILES = Object.freeze([
  'manifest.json',
  'sing-box.json',
  'state.json',
  'subscription-view.json',
]);
export const DEFAULT_MAX_REVISIONS = 32;
export const DEFAULT_MAX_REVISION_BYTES = 64 * 1024 * 1024;
const STAGING_STALE_MS = 10 * 60 * 1000;

export class RepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateGid(value, pathName) {
  if (value === null || value === undefined) return null;
  return expectInteger(value, pathName, { min: 0, max: 2_147_483_647 });
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function safeLstat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function syncDirectory(directoryPath) {
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

async function ensureOwnedDirectory(directoryPath, mode, {
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

async function writeExclusive(filePath, bytes, mode, ownerUid, ownerGid) {
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

async function readNoFollow(filePath, {
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

function parseJson(bytes, description) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new RepositoryError('INVALID_REVISION', `${description} is not valid JSON`);
  }
}

function validateManifest(value, expectedRevision) {
  if (!isPlainObject(value)) throw new RepositoryError('INVALID_REVISION', 'manifest is invalid');
  const keys = ['schemaVersion', 'revision', 'operation', 'createdAt', 'files'];
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new RepositoryError('INVALID_REVISION', 'manifest is invalid');
  }
  if (value.schemaVersion !== 1 || value.revision !== expectedRevision) {
    throw new RepositoryError('INVALID_REVISION', 'manifest revision does not match');
  }
  if (typeof value.operation !== 'string' || !/^[a-z][a-z0-9.-]{0,31}$/u.test(value.operation)) {
    throw new RepositoryError('INVALID_REVISION', 'manifest operation is invalid');
  }
  if (typeof value.createdAt !== 'string') throw new RepositoryError('INVALID_REVISION', 'manifest timestamp is invalid');
  if (!isPlainObject(value.files)) throw new RepositoryError('INVALID_REVISION', 'manifest files are invalid');
  const names = ['state.json', 'sing-box.json', 'subscription-view.json'];
  if (Object.keys(value.files).length !== names.length || !names.every((name) => Object.hasOwn(value.files, name))) {
    throw new RepositoryError('INVALID_REVISION', 'manifest files are invalid');
  }
  for (const name of names) {
    const record = value.files[name];
    if (!isPlainObject(record)
      || Object.keys(record).length !== 2
      || !/^[0-9a-f]{64}$/u.test(record.sha256)
      || !Number.isSafeInteger(record.size)
      || record.size < 2) {
      throw new RepositoryError('INVALID_REVISION', 'manifest file record is invalid');
    }
  }
  return value;
}

function manifestRecord(bytes) {
  return { sha256: digest(bytes), size: bytes.length };
}

async function inspectKnownRevisionFiles(directoryPath, {
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

async function removeKnownRevisionFiles(directoryPath, identity = {}) {
  if (await inspectKnownRevisionFiles(directoryPath, identity) === null) return;
  for (const name of REVISION_FILES) {
    await unlink(path.join(directoryPath, name)).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
  await rmdir(directoryPath);
}

export class RevisionRepository {
  constructor(root, {
    runtimeGid = null,
    subscriptionGid = null,
    renderConfig = renderSingBoxConfig,
    renderView = buildSubscriptionView,
    maxRevisions = DEFAULT_MAX_REVISIONS,
    maxRevisionBytes = DEFAULT_MAX_REVISION_BYTES,
    allowLegacyMigration = false,
  } = {}) {
    if (typeof NOFOLLOW !== 'number' || typeof DIRECTORY !== 'number') {
      throw new RepositoryError('UNSUPPORTED_PLATFORM', 'safe no-follow file operations are unavailable');
    }
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) === path.parse(root).root) {
      throw new TypeError('repository root must be a specific absolute path');
    }
    this.root = path.normalize(root);
    this.revisionsPath = path.join(this.root, 'revisions');
    this.runtimeGid = validateGid(runtimeGid, 'runtimeGid');
    this.subscriptionGid = validateGid(subscriptionGid, 'subscriptionGid');
    this.renderConfig = renderConfig;
    this.renderView = renderView;
    if (typeof allowLegacyMigration !== 'boolean') {
      throw new TypeError('allowLegacyMigration must be boolean');
    }
    this.allowLegacyMigration = allowLegacyMigration;
    this.ownerUid = SERVICE_UID;
    this.ownerGid = PRIVATE_GID;
    this.maxRevisions = expectInteger(maxRevisions, 'maxRevisions', { min: 2, max: 256 });
    this.maxRevisionBytes = expectInteger(maxRevisionBytes, 'maxRevisionBytes', {
      min: 1024 * 1024,
      max: 1024 * 1024 * 1024,
    });
  }

  async ensure() {
    const owner = { ownerUid: this.ownerUid, ownerGid: this.ownerGid };
    await ensureOwnedDirectory(this.root, ROOT_MODE, { create: true, ...owner });
    await ensureOwnedDirectory(this.revisionsPath, ROOT_MODE, { create: true, ...owner });
    const entries = await readdir(this.revisionsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!STAGING_ID.test(entry.name) && !REMOVAL_ID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new RepositoryError('UNSAFE_PATH', 'temporary revision entry is unsafe');
      }
      const temporaryPath = path.join(this.revisionsPath, entry.name);
      const identity = {
        ...owner,
        runtimeGid: this.runtimeGid ?? this.ownerGid,
        subscriptionGid: this.subscriptionGid ?? this.ownerGid,
      };
      const usage = await inspectKnownRevisionFiles(temporaryPath, identity);
      if (usage !== null && (
        REMOVAL_ID.test(entry.name)
        || Date.now() - usage.mtimeMs >= STAGING_STALE_MS
      )) {
        await removeKnownRevisionFiles(temporaryPath, identity);
      }
    }
    await syncDirectory(this.root);
    await syncDirectory(this.revisionsPath);
    return this;
  }

  /**
   * Remove every safely shaped staging/tombstone directory while the caller
   * holds the deployment's exclusive startup authority. Ordinary ensure()
   * retains recent staging directories to avoid racing an in-flight writer;
   * bootstrap/controller startup can use this stronger crash-recovery pass
   * before accepting requests.
   */
  async cleanupInterruptedWrites() {
    await this.ensure();
    const entries = await readdir(this.revisionsPath, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!STAGING_ID.test(entry.name) && !REMOVAL_ID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new RepositoryError('UNSAFE_PATH', 'temporary revision entry is unsafe');
      }
      await removeKnownRevisionFiles(path.join(this.revisionsPath, entry.name), {
        ownerUid: this.ownerUid,
        ownerGid: this.ownerGid,
        runtimeGid: this.runtimeGid ?? this.ownerGid,
        subscriptionGid: this.subscriptionGid ?? this.ownerGid,
      });
      removed += 1;
    }
    if (removed > 0) await syncDirectory(this.revisionsPath);
    return removed;
  }

  revisionPath(id) {
    if (typeof id !== 'string' || !REVISION_ID.test(id)) {
      throw new RepositoryError('INVALID_REVISION_ID', 'revision id is invalid');
    }
    return path.join(this.revisionsPath, id);
  }

  async assertRevisionDirectory(id) {
    const revisionPath = this.revisionPath(id);
    const stat = await safeLstat(revisionPath);
    if (stat === null) throw new RepositoryError('REVISION_NOT_FOUND', 'revision does not exist');
    let handle;
    try {
      handle = await open(revisionPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
      const opened = await handle.stat();
      if (
        !opened.isDirectory()
        || opened.uid !== this.ownerUid
        || opened.gid !== this.ownerGid
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

  async revisionUsage(id) {
    const revisionPath = await this.assertRevisionDirectory(id);
    const entries = await readdir(revisionPath, { withFileTypes: true });
    if (entries.some((entry) => !REVISION_FILES.includes(entry.name))) {
      throw new RepositoryError('INVALID_REVISION', 'revision directory contains an unexpected entry');
    }
    let bytes = 0;
    for (const entry of entries) {
      const stat = await lstat(path.join(revisionPath, entry.name));
      const expectedGid = entry.name === 'sing-box.json'
        ? this.runtimeGid ?? this.ownerGid
        : entry.name === 'subscription-view.json'
          ? this.subscriptionGid ?? this.ownerGid
          : this.ownerGid;
      const expectedMode = entry.name === 'sing-box.json'
        ? RUNTIME_FILE_MODE
        : entry.name === 'subscription-view.json'
          ? SUBSCRIPTION_FILE_MODE
          : PRIVATE_FILE_MODE;
      if (
        stat.isSymbolicLink()
        || !stat.isFile()
        || stat.nlink !== 1
        || stat.uid !== this.ownerUid
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

  async listRevisions() {
    await this.ensure();
    const entries = await readdir(this.revisionsPath, { withFileTypes: true });
    const ids = entries
      .filter((entry) => REVISION_ID.test(entry.name))
      .map((entry) => {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new RepositoryError('INVALID_REVISION', 'revision entry is unsafe');
        }
        return entry.name;
      })
      .sort();
    return Promise.all(ids.map((id) => this.revisionUsage(id)));
  }

  async removeRevision(id) {
    const [currentId, runtimeId] = await Promise.all([
      this.readPointer('current'),
      this.readPointer('runtime'),
    ]);
    if (id === currentId || id === runtimeId) return false;
    const revisionPath = this.revisionPath(id);
    const stat = await safeLstat(revisionPath);
    if (stat === null) return false;
    await this.revisionUsage(id);
    // Recheck protection immediately before the irreversible namespace change.
    // Controller mutations are serialized, and this second check also prevents
    // an accidental direct caller from deleting a newly activated revision.
    const [latestCurrentId, latestRuntimeId] = await Promise.all([
      this.readPointer('current'),
      this.readPointer('runtime'),
    ]);
    if (id === latestCurrentId || id === latestRuntimeId) return false;
    const removalPath = path.join(this.revisionsPath, `.remove-${id}-${randomUUID()}`);
    await rename(revisionPath, removalPath);
    // Once renamed, normal readers can only observe a complete revision or no
    // revision at all. A crash during the following unlink sequence leaves a
    // safely shaped tombstone that ensure() removes on its next invocation.
    await syncDirectory(this.revisionsPath);
    await removeKnownRevisionFiles(removalPath, {
      ownerUid: this.ownerUid,
      ownerGid: this.ownerGid,
      runtimeGid: this.runtimeGid ?? this.ownerGid,
      subscriptionGid: this.subscriptionGid ?? this.ownerGid,
    });
    await syncDirectory(this.revisionsPath);
    return true;
  }

  async pruneRevisions({ reserveCount = 0, reserveBytes = 0 } = {}) {
    expectInteger(reserveCount, 'reserveCount', { min: 0, max: 1 });
    expectInteger(reserveBytes, 'reserveBytes', { min: 0, max: this.maxRevisionBytes });
    const [records, currentId, runtimeId, rootEntries] = await Promise.all([
      this.listRevisions(),
      this.readPointer('current'),
      this.readPointer('runtime'),
      readdir(this.revisionsPath, { withFileTypes: true }),
    ]);
    const staging = [];
    for (const entry of rootEntries) {
      if (!STAGING_ID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new RepositoryError('UNSAFE_PATH', 'staging revision entry is unsafe');
      }
      const usage = await inspectKnownRevisionFiles(path.join(this.revisionsPath, entry.name), {
        ownerUid: this.ownerUid,
        ownerGid: this.ownerGid,
        runtimeGid: this.runtimeGid ?? this.ownerGid,
        subscriptionGid: this.subscriptionGid ?? this.ownerGid,
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
        count + reserveCount <= this.maxRevisions
        && bytes + reserveBytes <= this.maxRevisionBytes
      ) break;
      if (protectedIds.has(record.id)) continue;
      if (await this.removeRevision(record.id)) {
        count -= 1;
        bytes -= record.bytes;
        removed.push(record.id);
      }
    }
    if (
      count + reserveCount > this.maxRevisions
      || bytes + reserveBytes > this.maxRevisionBytes
    ) {
      throw new RepositoryError(
        'REVISION_QUOTA',
        'protected revisions exceed the repository retention budget',
      );
    }
    return Object.freeze({ count, bytes, removed: Object.freeze(removed) });
  }

  async createRevision(value, { operation = 'update' } = {}) {
    await this.ensure();
    const state = validateState(value);
    const normalizedOperation = expectString(operation, 'operation', { min: 1, max: 32 });
    if (!/^[a-z][a-z0-9.-]{0,31}$/u.test(normalizedOperation)) {
      throw new ValidationError('operation', 'must be a lowercase operation label');
    }
    const config = assertFailClosedConfig(this.renderConfig(state), state);
    const view = validateSubscriptionView(this.renderView(state));
    if (view.revision !== state.revision) {
      throw new RepositoryError('INVALID_RENDER', 'subscription projection revision does not match state');
    }
    const stateBytes = jsonBytes(state);
    const configBytes = jsonBytes(config);
    const viewBytes = jsonBytes(view);
    const manifest = {
      schemaVersion: 1,
      revision: state.revision,
      operation: normalizedOperation,
      createdAt: state.updatedAt,
      files: {
        'state.json': manifestRecord(stateBytes),
        'sing-box.json': manifestRecord(configBytes),
        'subscription-view.json': manifestRecord(viewBytes),
      },
    };
    const manifestBytes = jsonBytes(manifest);
    const id = `${String(state.revision).padStart(16, '0')}-${digest(stateBytes).slice(0, 16)}`;
    const finalPath = this.revisionPath(id);
    if (await safeLstat(finalPath) !== null) {
      throw new RepositoryError('REVISION_EXISTS', 'immutable revision already exists');
    }
    const incomingBytes = [stateBytes, configBytes, viewBytes, manifestBytes]
      .reduce((sum, bytes) => sum + bytes.length, 0);
    if (incomingBytes > this.maxRevisionBytes) {
      throw new RepositoryError('REVISION_QUOTA', 'candidate revision exceeds the retention budget');
    }
    await this.pruneRevisions({ reserveCount: 1, reserveBytes: incomingBytes });
    const stagingPath = path.join(this.revisionsPath, `.stage-${randomUUID()}`);
    let stagingCreated = false;
    let renamed = false;
    try {
      await mkdir(stagingPath, { mode: STAGING_DIRECTORY_MODE });
      stagingCreated = true;
      await ensureOwnedDirectory(stagingPath, STAGING_DIRECTORY_MODE, {
        ownerUid: this.ownerUid,
        ownerGid: this.ownerGid,
      });
      await writeExclusive(
        path.join(stagingPath, 'state.json'),
        stateBytes,
        PRIVATE_FILE_MODE,
        this.ownerUid,
        this.ownerGid,
      );
      await writeExclusive(
        path.join(stagingPath, 'sing-box.json'),
        configBytes,
        RUNTIME_FILE_MODE,
        this.ownerUid,
        this.runtimeGid ?? this.ownerGid,
      );
      await writeExclusive(
        path.join(stagingPath, 'subscription-view.json'),
        viewBytes,
        SUBSCRIPTION_FILE_MODE,
        this.ownerUid,
        this.subscriptionGid ?? this.ownerGid,
      );
      await writeExclusive(
        path.join(stagingPath, 'manifest.json'),
        manifestBytes,
        PRIVATE_FILE_MODE,
        this.ownerUid,
        this.ownerGid,
      );
      await chmod(stagingPath, REVISION_DIRECTORY_MODE);
      await syncDirectory(stagingPath);
      await rename(stagingPath, finalPath);
      renamed = true;
      await syncDirectory(this.revisionsPath);
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
        throw new RepositoryError('REVISION_EXISTS', 'immutable revision already exists');
      }
      throw error;
    } finally {
      if (stagingCreated && !renamed) {
        await removeKnownRevisionFiles(stagingPath, {
          ownerUid: this.ownerUid,
          ownerGid: this.ownerGid,
          runtimeGid: this.runtimeGid ?? this.ownerGid,
          subscriptionGid: this.subscriptionGid ?? this.ownerGid,
        }).catch(() => {});
      }
    }
    return Object.freeze({ id, revision: state.revision, path: finalPath, manifest });
  }

  async readRevisionInternal(id, allowLegacyMigration) {
    const revisionPath = await this.assertRevisionDirectory(id);
    const stateBytes = await readNoFollow(path.join(revisionPath, 'state.json'), {
      maxBytes: 1024 * 1024,
      expectedMode: PRIVATE_FILE_MODE,
      expectedUid: this.ownerUid,
      expectedGid: this.ownerGid,
    });
    const configBytes = await readNoFollow(path.join(revisionPath, 'sing-box.json'), {
      maxBytes: 4 * 1024 * 1024,
      expectedMode: RUNTIME_FILE_MODE,
      expectedUid: this.ownerUid,
      expectedGid: this.runtimeGid ?? this.ownerGid,
    });
    const viewBytes = await readNoFollow(path.join(revisionPath, 'subscription-view.json'), {
      maxBytes: 1024 * 1024,
      expectedMode: SUBSCRIPTION_FILE_MODE,
      expectedUid: this.ownerUid,
      expectedGid: this.subscriptionGid ?? this.ownerGid,
    });
    const manifestBytes = await readNoFollow(path.join(revisionPath, 'manifest.json'), {
      maxBytes: 64 * 1024,
      expectedMode: PRIVATE_FILE_MODE,
      expectedUid: this.ownerUid,
      expectedGid: this.ownerGid,
    });
    let rawState;
    let rawConfig;
    let rawView;
    let manifest;
    try {
      rawState = parseJson(stateBytes, 'state');
      rawConfig = parseJson(configBytes, 'sing-box config');
      rawView = parseJson(viewBytes, 'subscription projection');
      manifest = validateManifest(parseJson(manifestBytes, 'manifest'), rawState?.revision);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError('INVALID_REVISION', 'revision content is semantically invalid');
    }
    const actual = {
      'state.json': manifestRecord(stateBytes),
      'sing-box.json': manifestRecord(configBytes),
      'subscription-view.json': manifestRecord(viewBytes),
    };
    for (const [name, record] of Object.entries(actual)) {
      if (manifest.files[name].sha256 !== record.sha256 || manifest.files[name].size !== record.size) {
        throw new RepositoryError('REVISION_TAMPERED', 'revision content does not match its manifest');
      }
    }

    // Authenticate every raw byte before choosing a schema-specific parser.
    // Legacy state is returned only as an explicit migration source; it is
    // never normalized into the active schema or accepted by a writer.
    let state;
    let config;
    let subscriptionView;
    let requiresIngressMigration = false;
    try {
      if (rawState?.schemaVersion === 3) {
        state = validateState(rawState);
        config = assertFailClosedConfig(rawConfig, state);
        subscriptionView = validateSubscriptionView(rawView);
      } else {
        if (!allowLegacyMigration || rawState?.schemaVersion !== 2) {
          throw new ValidationError('state.schemaVersion', 'requires an explicit supported migration');
        }
        ({ state, config, subscriptionView } = validateLegacyV2Revision(
          rawState,
          rawConfig,
          rawView,
        ));
        requiresIngressMigration = true;
      }
      if (manifest.createdAt !== state.updatedAt) {
        throw new RepositoryError('INVALID_REVISION', 'manifest timestamp does not match state');
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError('INVALID_REVISION', 'revision content is semantically invalid');
    }
    if (subscriptionView.revision !== state.revision) {
      throw new RepositoryError('INVALID_REVISION', 'subscription projection revision does not match state');
    }
    if (!requiresIngressMigration) {
      try {
        const expectedView = validateSubscriptionView(this.renderView(state));
        if (JSON.stringify(subscriptionView) !== JSON.stringify(expectedView)) {
          throw new RepositoryError('INVALID_REVISION', 'subscription projection does not match state');
        }
      } catch (error) {
        if (error instanceof RepositoryError) throw error;
        throw new RepositoryError('INVALID_REVISION', 'subscription projection is semantically invalid');
      }
    }
    return {
      id,
      path: revisionPath,
      state,
      config,
      subscriptionView,
      manifest,
      requiresIngressMigration,
    };
  }

  async readRevision(id) {
    return this.readRevisionInternal(id, this.allowLegacyMigration);
  }

  /**
   * After a strict current revision has passed routed readiness, the controller
   * may recognize and retire an exact previous-policy historical revision. It
   * is never eligible to become current/runtime through this method.
   */
  async readRevisionForRetirement(id) {
    return this.readRevisionInternal(id, true);
  }

  async readPointer(name) {
    if (!POINTER_NAMES.has(name)) throw new TypeError('pointer name is invalid');
    await this.ensure();
    const pointerPath = path.join(this.root, name);
    const stat = await safeLstat(pointerPath);
    if (stat === null) return null;
    if (!stat.isSymbolicLink() || stat.uid !== this.ownerUid) {
      throw new RepositoryError('UNSAFE_POINTER', 'repository pointer ownership or type is unsafe');
    }
    const target = await readlink(pointerPath);
    const prefix = 'revisions/';
    if (!target.startsWith(prefix) || target.includes('\\') || path.posix.normalize(target) !== target) {
      throw new RepositoryError('UNSAFE_POINTER', 'repository pointer target is invalid');
    }
    const id = target.slice(prefix.length);
    await this.assertRevisionDirectory(id);
    return id;
  }

  async swapPointer(name, id) {
    if (!POINTER_NAMES.has(name)) throw new TypeError('pointer name is invalid');
    await this.ensure();
    await this.assertRevisionDirectory(id);
    const pointerPath = path.join(this.root, name);
    const existing = await safeLstat(pointerPath);
    if (existing !== null && (!existing.isSymbolicLink() || existing.uid !== this.ownerUid)) {
      throw new RepositoryError('UNSAFE_POINTER', 'repository pointer ownership or type is unsafe');
    }
    const temporaryPath = path.join(this.root, `.${name}-${randomUUID()}`);
    try {
      await symlink(`revisions/${id}`, temporaryPath, 'dir');
      await rename(temporaryPath, pointerPath);
      await syncDirectory(this.root);
    } finally {
      await unlink(temporaryPath).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    }
    return id;
  }

  async activateCurrent(id) {
    return this.swapPointer('current', id);
  }

  async activateRuntime(id) {
    return this.swapPointer('runtime', id);
  }

  async readCurrent() {
    const id = await this.readPointer('current');
    return id === null ? null : this.readRevision(id);
  }

  async readRuntime() {
    const id = await this.readPointer('runtime');
    return id === null ? null : this.readRevision(id);
  }

  async readCurrentState() {
    return (await this.readCurrent())?.state ?? null;
  }

  async readCurrentSubscriptionView() {
    return (await this.readCurrent())?.subscriptionView ?? null;
  }

  async initialize(value, options) {
    await this.ensure();
    const [currentId, runtimeId] = await Promise.all([
      this.readPointer('current'),
      this.readPointer('runtime'),
    ]);
    if (currentId !== null || runtimeId !== null) {
      // Finish only the two possible interrupted initialization states. Once a
      // current pointer exists it is authoritative; a later controller recovery
      // will deliberately reconcile any runtime mismatch.
      if (currentId === null && runtimeId !== null) {
        const recovered = await this.readRevision(runtimeId);
        await this.activateCurrent(runtimeId);
        return Object.freeze({
          id: recovered.id,
          revision: recovered.state.revision,
          path: recovered.path,
          manifest: recovered.manifest,
        });
      }
      if (currentId !== null && runtimeId === null) {
        const recovered = await this.readRevision(currentId);
        await this.activateRuntime(currentId);
        return Object.freeze({
          id: recovered.id,
          revision: recovered.state.revision,
          path: recovered.path,
          manifest: recovered.manifest,
        });
      }
      throw new RepositoryError('ALREADY_INITIALIZED', 'repository pointers already exist');
    }
    const revision = await this.createRevision(value, options);
    await this.activateRuntime(revision.id);
    await this.activateCurrent(revision.id);
    return revision;
  }
}

export const StateRepository = RevisionRepository;
