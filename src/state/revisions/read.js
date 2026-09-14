import path from 'node:path';
import { assertFailClosedConfig } from '../../core/server/assert.js';
import { validateState } from '../../core/model/state.js';
import { validateSubscriptionView } from '../../core/subscriptions/view.js';
import {
  PRIVATE_FILE_MODE,
  RUNTIME_FILE_MODE,
  SUBSCRIPTION_FILE_MODE,
  RepositoryError,
} from '../filesystem/policy.js';
import { readNoFollow } from '../filesystem/files.js';
import { parseJson, validateManifest, manifestRecord } from './manifest.js';

// A valid current revision may recover a damaged runtime candidate. Inspect
// only enough to reject a clearly unsupported schema before that recovery.
export async function assertSupportedRevisionSchema(repository, id) {
  const revisionPath = await repository.assertRevisionDirectory(id);
  let schemaVersion;
  try {
    const bytes = await readNoFollow(path.join(revisionPath, 'state.json'), {
      maxBytes: 1024 * 1024,
      expectedMode: PRIVATE_FILE_MODE,
      expectedUid: repository.ownerUid,
      expectedGid: repository.ownerGid,
    });
    schemaVersion = parseJson(bytes, 'state')?.schemaVersion;
  } catch {
    return;
  }
  if (Number.isInteger(schemaVersion) && schemaVersion !== 3) {
    throw new RepositoryError('UNSUPPORTED_SCHEMA', 'only state schema version 3 is supported');
  }
}

export async function readRevision(repository, id) {
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

  // Verify every raw byte before accepting the supported state schema.
  if (rawState?.schemaVersion !== 3) {
    throw new RepositoryError('UNSUPPORTED_SCHEMA', 'only state schema version 3 is supported');
  }
  let state;
  let config;
  let subscriptionView;
  try {
    state = validateState(rawState);
    config = assertFailClosedConfig(rawConfig, state);
    subscriptionView = validateSubscriptionView(rawView);
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
  try {
    const expectedView = validateSubscriptionView(repository.renderView(state));
    if (JSON.stringify(subscriptionView) !== JSON.stringify(expectedView)) {
      throw new RepositoryError('INVALID_REVISION', 'subscription projection does not match state');
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError('INVALID_REVISION', 'subscription projection is semantically invalid');
  }
  return {
    id,
    path: revisionPath,
    state,
    config,
    subscriptionView,
    manifest,
  };
}
