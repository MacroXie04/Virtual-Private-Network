import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateCandidateConfig } from '../state/bootstrap-candidate.js';
import { validateState } from '../core/state-schema.js';
import { buildMigratedState } from './legacy-v1-state.js';
import { pathExists } from './legacy-v1-source.js';
import {
  migrationLineageError,
  migrationLineageRecord,
  assertMigrationLineageMatches,
  readMigrationLineage,
} from './migration-lineage-record.js';
import { MigrationError } from './migration-errors.js';

export function reconstructLegacyInitialState({
  inspection,
  fallbackEnvironment,
  expectedStateDirectory,
  candidateState,
  apiKey,
}) {
  const healthPassword = Buffer.from(candidateState.health.password, 'base64url');
  return buildMigratedState({
    legacyEnvironment: inspection.legacyEnvironment,
    legacyConfig: inspection.legacyConfig,
    fallbackEnvironment: {
      ...fallbackEnvironment,
      MIGRATION_STATE_DIR: expectedStateDirectory,
    },
    apiKey,
    adminRecord: candidateState.admin.scrypt,
    randomBytesImpl: (size) => {
      if (size !== healthPassword.length) {
        throw migrationLineageError('legacy migration health credentials are inconsistent');
      }
      return healthPassword;
    },
    now: candidateState.createdAt,
  }).state;
}

export function expectedCredentialScrubState(expectedInitial, updatedAt) {
  return validateState({
    ...expectedInitial,
    revision: 2,
    updatedAt,
    tailscale: {
      ...expectedInitial.tailscale,
      authKey: null,
      apiKey: null,
    },
  });
}

export async function recoverLegacyMigrationOrphan({
  repository,
  revisions,
  marker,
  inspection,
  env,
  apiKey,
  stateDirectory,
  dataDir,
  singBoxPath,
  execFileImpl,
  validateConfigImpl,
}) {
  if (revisions.length === 0) return null;
  if (marker === null) {
    throw new MigrationError(
      'ORPHANED_REVISION',
      'an unpointed revision cannot be recovered without the approved legacy migration marker',
    );
  }
  if (marker.statePublished || revisions.length !== 1 || !(await pathExists(marker.lineagePath))) {
    throw migrationLineageError('legacy migration orphan set is not an authorized pre-publication state');
  }
  const lineage = await readMigrationLineage(marker.lineagePath);
  const orphan = await repository.readRevision(revisions[0].id);
  const expectedInitial = reconstructLegacyInitialState({
    inspection,
    fallbackEnvironment: env,
    expectedStateDirectory: stateDirectory,
    candidateState: orphan.state,
    apiKey,
  });
  const expectedLineage = migrationLineageRecord(expectedInitial);
  assertMigrationLineageMatches(lineage, expectedLineage);
  if (orphan.id !== expectedLineage.initialRevisionId
      || orphan.manifest.operation !== 'migrate-v1'
      || orphan.state.revision !== 1
      || !isDeepStrictEqual(orphan.state, expectedInitial)) {
    throw migrationLineageError('unpointed revision is not the exact approved migrate-v1 candidate');
  }
  await validateCandidateConfig(orphan.state, {
    dataDir,
    singBoxPath,
    execFileImpl,
    validateConfigImpl,
  });
  await repository.activateRuntime(orphan.id);
  await repository.activateCurrent(orphan.id);
  return Object.freeze({
    status: 'recovered',
    id: orphan.id,
    revision: orphan.state.revision,
    adminSecretPath: path.join(dataDir, 'admin-secret'),
  });
}
