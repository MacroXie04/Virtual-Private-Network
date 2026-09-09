import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename } from 'node:fs/promises';
import { assertFailClosedConfig } from '../../core/server/assert.js';
import { validateState } from '../../core/model/state.js';
import { validateSubscriptionView } from '../../core/subscriptions/view.js';
import { ValidationError, expectString } from '../../core/validation/values.js';
import {
  REVISION_DIRECTORY_MODE,
  STAGING_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  RUNTIME_FILE_MODE,
  SUBSCRIPTION_FILE_MODE,
  RepositoryError,
} from '../filesystem/policy.js';
import { safeLstat, syncDirectory, ensureOwnedDirectory, writeExclusive } from '../filesystem/files.js';
import { jsonBytes, digest, manifestRecord } from './manifest.js';
import { removeKnownRevisionFiles } from '../filesystem/revision-directory.js';

export async function createRevision(repository, value, { operation = 'update' } = {}) {
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
  await repository.ensure();
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
