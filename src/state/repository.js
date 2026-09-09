import path from 'node:path';
import { buildSubscriptionView } from '../core/subscriptions/view.js';
import { renderSingBoxConfig } from '../core/server/render.js';
import { expectInteger } from '../core/validation/values.js';
import {
  NOFOLLOW,
  DIRECTORY,
  SERVICE_UID,
  PRIVATE_GID,
  DEFAULT_MAX_REVISIONS,
  DEFAULT_MAX_REVISION_BYTES,
  RepositoryError,
} from './filesystem/policy.js';
import { revisionPath, assertRevisionDirectory, revisionUsage } from './filesystem/revision-directory.js';
import {
  ensure,
  cleanupInterruptedWrites,
  listRevisions,
  removeRevision,
  pruneRevisions,
} from './revisions/retention.js';
import { assertSupportedRevisionSchema, readRevision } from './revisions/read.js';
import { createRevision } from './revisions/write.js';
import { readPointer, swapPointer, initialize } from './revisions/pointers.js';

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

  async readRevision(id) {
    return readRevision(this, id);
  }

  async assertSupportedRevisionSchema(id) {
    return assertSupportedRevisionSchema(this, id);
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
