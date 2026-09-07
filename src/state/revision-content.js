import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename } from 'node:fs/promises';
import { assertFailClosedConfig } from '../core/server-config-assert.js';
import { validateLegacyV2Revision } from '../migrations/legacy-v2-policy.js';
import { validateState } from '../core/state-schema.js';
import { validateSubscriptionView } from '../core/subscription-view.js';
import { ValidationError, expectString } from '../core/validation.js';
import {
  REVISION_DIRECTORY_MODE,
  STAGING_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  RUNTIME_FILE_MODE,
  SUBSCRIPTION_FILE_MODE,
  RepositoryError,
} from './repository-policy.js';
import {
  safeLstat,
  syncDirectory,
  ensureOwnedDirectory,
  writeExclusive,
  readNoFollow,
} from './repository-files.js';
import {
  jsonBytes,
  digest,
  parseJson,
  validateManifest,
  manifestRecord,
} from './revision-manifest.js';
import { removeKnownRevisionFiles } from './revision-directory.js';

export async function createRevision(repository, value, { operation = 'update' } = {}) {
  await repository.ensure();
  const state = validateState(value);
  const normalizedOperation = expectString(operation, 'operation', { min: 1, max: 32 });
  if (!/^[a-z][a-z0-9.-]{0,31}$/u.test(normalizedOperation)) {
    throw new ValidationError('operation', 'must be a lowercase operation label');
  }
  const config = assertFailClosedConfig(repository.renderConfig(state), state);
  const view = validateSubscriptionView(repository.renderView(state));
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
  const finalPath = repository.revisionPath(id);
  if (await safeLstat(finalPath) !== null) {
    throw new RepositoryError('REVISION_EXISTS', 'immutable revision already exists');
  }
  const incomingBytes = [stateBytes, configBytes, viewBytes, manifestBytes]
    .reduce((sum, bytes) => sum + bytes.length, 0);
  if (incomingBytes > repository.maxRevisionBytes) {
    throw new RepositoryError('REVISION_QUOTA', 'candidate revision exceeds the retention budget');
  }
  await repository.pruneRevisions({ reserveCount: 1, reserveBytes: incomingBytes });
  const stagingPath = path.join(repository.revisionsPath, `.stage-${randomUUID()}`);
  let stagingCreated = false;
  let renamed = false;
  try {
    await mkdir(stagingPath, { mode: STAGING_DIRECTORY_MODE });
    stagingCreated = true;
    await ensureOwnedDirectory(stagingPath, STAGING_DIRECTORY_MODE, {
      ownerUid: repository.ownerUid,
      ownerGid: repository.ownerGid,
    });
    await writeExclusive(
      path.join(stagingPath, 'state.json'),
      stateBytes,
      PRIVATE_FILE_MODE,
      repository.ownerUid,
      repository.ownerGid,
    );
    await writeExclusive(
      path.join(stagingPath, 'sing-box.json'),
      configBytes,
      RUNTIME_FILE_MODE,
      repository.ownerUid,
      repository.runtimeGid ?? repository.ownerGid,
    );
    await writeExclusive(
      path.join(stagingPath, 'subscription-view.json'),
      viewBytes,
      SUBSCRIPTION_FILE_MODE,
      repository.ownerUid,
      repository.subscriptionGid ?? repository.ownerGid,
    );
    await writeExclusive(
      path.join(stagingPath, 'manifest.json'),
      manifestBytes,
      PRIVATE_FILE_MODE,
      repository.ownerUid,
      repository.ownerGid,
    );
    await chmod(stagingPath, REVISION_DIRECTORY_MODE);
    await syncDirectory(stagingPath);
    await rename(stagingPath, finalPath);
    renamed = true;
    await syncDirectory(repository.revisionsPath);
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
      throw new RepositoryError('REVISION_EXISTS', 'immutable revision already exists');
    }
    throw error;
  } finally {
    if (stagingCreated && !renamed) {
      await removeKnownRevisionFiles(stagingPath, {
        ownerUid: repository.ownerUid,
        ownerGid: repository.ownerGid,
        runtimeGid: repository.runtimeGid ?? repository.ownerGid,
        subscriptionGid: repository.subscriptionGid ?? repository.ownerGid,
      }).catch(() => {});
    }
  }
  return Object.freeze({ id, revision: state.revision, path: finalPath, manifest });
}

export async function readRevisionInternal(repository, id, allowLegacyMigration) {
  const revisionPath = await repository.assertRevisionDirectory(id);
  const stateBytes = await readNoFollow(path.join(revisionPath, 'state.json'), {
    maxBytes: 1024 * 1024,
    expectedMode: PRIVATE_FILE_MODE,
    expectedUid: repository.ownerUid,
    expectedGid: repository.ownerGid,
  });
  const configBytes = await readNoFollow(path.join(revisionPath, 'sing-box.json'), {
    maxBytes: 4 * 1024 * 1024,
    expectedMode: RUNTIME_FILE_MODE,
    expectedUid: repository.ownerUid,
    expectedGid: repository.runtimeGid ?? repository.ownerGid,
  });
  const viewBytes = await readNoFollow(path.join(revisionPath, 'subscription-view.json'), {
    maxBytes: 1024 * 1024,
    expectedMode: SUBSCRIPTION_FILE_MODE,
    expectedUid: repository.ownerUid,
    expectedGid: repository.subscriptionGid ?? repository.ownerGid,
  });
  const manifestBytes = await readNoFollow(path.join(revisionPath, 'manifest.json'), {
    maxBytes: 64 * 1024,
    expectedMode: PRIVATE_FILE_MODE,
    expectedUid: repository.ownerUid,
    expectedGid: repository.ownerGid,
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
      const expectedView = validateSubscriptionView(repository.renderView(state));
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
