import { isDeepStrictEqual } from 'node:util';
import { readBoundedFileNoFollow, writePrivateFileExclusive } from '../state/bootstrap-files.js';
import { RevisionRepository } from '../state/repository.js';
import { validateAbsoluteStatePath } from '../core/validation.js';
import { pathExists, inspectLegacyV1, resolveMigrationApiKey } from './legacy-v1-source.js';
import {
  migrationLineageError,
  migrationLineageRecord,
  parseMigrationLineage,
  assertMigrationLineageMatches,
} from './migration-lineage-record.js';
import {
  reconstructLegacyInitialState,
  expectedCredentialScrubState,
} from './migration-recovery.js';

/**
 * Bind installer recovery to the reviewed initial revision or its exact
 * credential-scrub successor. Operation labels alone do not establish lineage.
 */
export async function assertLegacyV1MigrationLineage({
  dataDir,
  envPath,
  configPath,
  fallbackEnvironment = {},
  expectedStateDirectory,
  lineagePath,
  statePublished = false,
  repository = null,
} = {}) {
  const normalizedDataDir = validateAbsoluteStatePath(dataDir, 'DATA_DIR');
  const normalizedStateDirectory = validateAbsoluteStatePath(
    expectedStateDirectory,
    'EXPECTED_STATE_DIRECTORY',
  );
  const normalizedLineagePath = validateAbsoluteStatePath(lineagePath, 'MIGRATION_LINEAGE_FILE');
  if (typeof statePublished !== 'boolean') {
    throw new TypeError('statePublished must be a boolean');
  }
  const repo = repository ?? new RevisionRepository(normalizedDataDir);
  const [current, runtime] = await Promise.all([
    repo.readCurrent(),
    repo.readRuntime(),
  ]);
  if (!current || !runtime || current.id !== runtime.id) {
    throw migrationLineageError('legacy migration pointers do not identify one authoritative revision');
  }

  const inspection = await inspectLegacyV1({
    envPath,
    configPath,
    fallbackEnvironment: {
      ...fallbackEnvironment,
      MIGRATION_STATE_DIR: normalizedStateDirectory,
    },
  });
  const apiKey = await resolveMigrationApiKey(fallbackEnvironment, inspection);
  const expectedInitial = reconstructLegacyInitialState({
    inspection,
    fallbackEnvironment: {
      ...fallbackEnvironment,
      MIGRATION_STATE_DIR: normalizedStateDirectory,
    },
    expectedStateDirectory: normalizedStateDirectory,
    candidateState: current.state,
    apiKey,
  });
  const expectedLineage = migrationLineageRecord(expectedInitial);
  let status;
  if (current.manifest.operation === 'migrate-v1') {
    if (current.id !== expectedLineage.initialRevisionId
        || current.state.revision !== 1
        || !isDeepStrictEqual(current.state, expectedInitial)) {
      throw migrationLineageError('current migrate-v1 revision does not match the reviewed legacy sources');
    }
    status = 'migrate-v1';
  } else if (current.manifest.operation === 'credentials.scrub') {
    if (!statePublished) {
      throw migrationLineageError('credential scrub appeared before the migration state was published');
    }
    if (expectedInitial.tailscale.authKey === null && expectedInitial.tailscale.apiKey === null) {
      throw migrationLineageError('credential scrub has no credential-bearing migration predecessor');
    }
    const expectedScrub = expectedCredentialScrubState(expectedInitial, current.state.updatedAt);
    if (current.state.revision !== 2 || !isDeepStrictEqual(current.state, expectedScrub)) {
      throw migrationLineageError('current credential scrub is not the exact successor of the legacy migration');
    }
    status = 'credentials.scrub';
  } else {
    throw migrationLineageError('current revision is not part of the allowed legacy migration lineage');
  }

  let lineage;
  let publishLineage = false;
  if (await pathExists(normalizedLineagePath)) {
    lineage = parseMigrationLineage(await readBoundedFileNoFollow(normalizedLineagePath, {
      maxBytes: 1024,
      requirePrivate: true,
      description: 'legacy migration lineage record',
    }));
    assertMigrationLineageMatches(lineage, expectedLineage);
  } else {
    if (status !== 'migrate-v1' || statePublished) {
      throw migrationLineageError('legacy migration lineage record is missing');
    }
    lineage = expectedLineage;
    publishLineage = true;
  }

  const revisions = await repo.listRevisions();
  const others = revisions.filter((revision) => revision.id !== current.id);
  if (status === 'migrate-v1' && others.length > 0) {
    if (!statePublished || others.length !== 1) {
      throw migrationLineageError('legacy migration repository contains an unrelated revision');
    }
    if (expectedInitial.tailscale.authKey === null && expectedInitial.tailscale.apiKey === null) {
      throw migrationLineageError('interrupted credential scrub has no credential-bearing predecessor');
    }
    const interruptedScrub = await repo.readRevision(others[0].id);
    const expectedScrub = expectedCredentialScrubState(
      expectedInitial,
      interruptedScrub.state.updatedAt,
    );
    if (interruptedScrub.manifest.operation !== 'credentials.scrub'
        || interruptedScrub.state.revision !== 2
        || !isDeepStrictEqual(interruptedScrub.state, expectedScrub)) {
      throw migrationLineageError('interrupted credential scrub is not an exact migration successor');
    }
    const removed = await repo.removeRevision(interruptedScrub.id);
    if (!removed) {
      throw migrationLineageError('interrupted credential scrub could not be retired safely');
    }
  } else if (status === 'credentials.scrub') {
    for (const revision of others) {
      if (revision.id !== lineage.initialRevisionId) {
        throw migrationLineageError('legacy migration repository contains an unrelated revision');
      }
      const predecessor = await repo.readRevision(revision.id);
      if (predecessor.manifest.operation !== 'migrate-v1'
          || !isDeepStrictEqual(predecessor.state, expectedInitial)) {
        throw migrationLineageError('credential scrub predecessor is not the published migrate-v1 revision');
      }
    }
  }
  if (publishLineage) {
    await writePrivateFileExclusive(
      normalizedLineagePath,
      Buffer.from(`${JSON.stringify(lineage, null, 2)}\n`, 'utf8'),
    );
  }

  return Object.freeze({
    status,
    id: current.id,
    revision: current.state.revision,
    initialRevisionId: lineage.initialRevisionId,
  });
}
