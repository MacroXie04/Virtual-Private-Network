import path from 'node:path';
import { buildSubscriptionView } from '../core/subscription-view.js';
import { renderSingBoxConfig } from '../core/server-render.js';
import { expectInteger } from '../core/validation.js';
import {
  NOFOLLOW,
  DIRECTORY,
  SERVICE_UID,
  PRIVATE_GID,
  DEFAULT_MAX_REVISIONS,
  DEFAULT_MAX_REVISION_BYTES,
  RepositoryError,
} from './repository-policy.js';
import { revisionPath, assertRevisionDirectory, revisionUsage } from './revision-directory.js';
import {
  ensure,
  cleanupInterruptedWrites,
  listRevisions,
  removeRevision,
  pruneRevisions,
} from './revision-retention.js';
import { createRevision, readRevisionInternal } from './revision-content.js';
import { readPointer, swapPointer, initialize } from './repository-pointers.js';

function validateGid(value, pathName) {
  if (value === null || value === undefined) return null;
  return expectInteger(value, pathName, { min: 0, max: 2_147_483_647 });
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
    return ensure(this);
  }

  async cleanupInterruptedWrites() {
    return cleanupInterruptedWrites(this);
  }

  revisionPath(id) {
    return revisionPath(this, id);
  }

  async assertRevisionDirectory(id) {
    return assertRevisionDirectory(this, id);
  }

  async revisionUsage(id) {
    return revisionUsage(this, id);
  }

  async listRevisions() {
    return listRevisions(this);
  }

  async removeRevision(id) {
    return removeRevision(this, id);
  }

  async pruneRevisions(options) {
    return pruneRevisions(this, options);
  }

  async createRevision(value, options) {
    return createRevision(this, value, options);
  }

  async readRevisionInternal(id, allowLegacyMigration) {
    return readRevisionInternal(this, id, allowLegacyMigration);
  }

  async readRevision(id) {
    return this.readRevisionInternal(id, this.allowLegacyMigration);
  }

  /** Recognize historical policy only for retirement after routed readiness. */
  async readRevisionForRetirement(id) {
    return this.readRevisionInternal(id, true);
  }

  async readPointer(name) {
    return readPointer(this, name);
  }

  async swapPointer(name, id) {
    return swapPointer(this, name, id);
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
    return initialize(this, value, options);
  }
}

export const StateRepository = RevisionRepository;
