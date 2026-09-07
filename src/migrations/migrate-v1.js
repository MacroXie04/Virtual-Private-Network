import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { prepareAdminSecret, persistPreparedAdminSecret } from '../state/bootstrap-credentials.js';
import { validateCandidateConfig } from '../state/bootstrap-candidate.js';
import { writePrivateFileExclusive } from '../state/bootstrap-files.js';
import { createAdminScryptRecord } from '../core/credentials.js';
import { RevisionRepository } from '../state/repository.js';
import { validateAbsoluteStatePath } from '../core/validation.js';
import { migrationTimestamp, buildMigratedState } from './legacy-v1-state.js';
import { pathExists, inspectLegacyV1, resolveMigrationApiKey } from './legacy-v1-source.js';
import {
  migrationLineageError,
  migrationLineageRecord,
  readMigrationLineage,
} from './migration-lineage-record.js';
import { createLegacyBackup } from './migration-backup.js';
import { authenticateLegacyMigrationMarker } from './migration-marker.js';
import { recoverLegacyMigrationOrphan } from './migration-recovery.js';

export async function migrateLegacyV1({
  apply = false,
  dataDir,
  envPath,
  configPath,
  env = {},
  repository = null,
  singBoxPath = '/usr/local/bin/sing-box',
  execFileImpl,
  validateConfigImpl,
  randomBytesImpl = randomBytes,
  now = () => new Date(),
} = {}) {
  const normalizedDataDir = validateAbsoluteStatePath(dataDir, 'DATA_DIR');
  const repo = repository ?? new RevisionRepository(normalizedDataDir);
  if (apply) {
    const existing = await repo.readCurrent();
    if (existing !== null) {
      return Object.freeze({ status: 'existing', id: existing.id, revision: existing.state.revision });
    }
  } else if (await pathExists(path.join(normalizedDataDir, 'current'))) {
    const existing = await repo.readCurrent();
    if (existing !== null) {
      return Object.freeze({ status: 'existing', id: existing.id, revision: existing.state.revision });
    }
  }

  const inspection = await inspectLegacyV1({
    envPath,
    configPath,
    fallbackEnvironment: env,
  });
  const apiKey = await resolveMigrationApiKey(env, inspection);
  if (!apply) {
    return Object.freeze({
      status: 'dry-run',
      sourcePaths: Object.freeze([envPath, configPath]),
      summary: inspection.summary,
    });
  }

  const marker = await authenticateLegacyMigrationMarker({
    dataDir: normalizedDataDir,
    markerDir: env.MIGRATION_MARKER_DIR,
    inspection,
  });
  const revisions = await repo.listRevisions();
  const recovered = await recoverLegacyMigrationOrphan({
    repository: repo,
    revisions,
    marker,
    inspection,
    env,
    apiKey,
    stateDirectory: validateAbsoluteStatePath(
      env.MIGRATION_STATE_DIR
        || inspection.legacyConfig.stateDirectory
        || inspection.legacyEnvironment.SINGBOX_STATE_DIR
        || env.SINGBOX_STATE_DIR,
      'SINGBOX_STATE_DIR',
    ),
    dataDir: normalizedDataDir,
    singBoxPath,
    execFileImpl,
    validateConfigImpl,
  });
  if (recovered !== null) return recovered;
  if (marker?.statePublished) {
    throw migrationLineageError('migration state was marked published without an authoritative revision');
  }
  if (marker && await pathExists(marker.lineagePath)) {
    // A crash after publishing intent but before the immutable revision leaves
    // no authority to recover. Validate and remove only that private intent;
    // the new attempt will publish a fresh commitment before its revision.
    await readMigrationLineage(marker.lineagePath);
    await unlink(marker.lineagePath);
  }

  const timestamp = migrationTimestamp(now);
  const preparedAdmin = await prepareAdminSecret(normalizedDataDir, { randomBytesImpl });
  const adminRecord = await createAdminScryptRecord(preparedAdmin.secret, { randomBytesImpl });
  const { state } = buildMigratedState({
    legacyEnvironment: inspection.legacyEnvironment,
    legacyConfig: inspection.legacyConfig,
    fallbackEnvironment: env,
    apiKey,
    adminRecord,
    randomBytesImpl,
    now: timestamp,
  });
  await validateCandidateConfig(state, {
    dataDir: normalizedDataDir,
    singBoxPath,
    execFileImpl,
    validateConfigImpl,
  });
  const backupPath = await createLegacyBackup({
    dataDir: normalizedDataDir,
    inspection,
    timestamp,
    randomBytesImpl,
  });
  await persistPreparedAdminSecret(preparedAdmin);
  if (marker !== null) {
    await writePrivateFileExclusive(
      marker.lineagePath,
      Buffer.from(`${JSON.stringify(migrationLineageRecord(state), null, 2)}\n`, 'utf8'),
    );
  }
  const revision = await repo.initialize(state, { operation: 'migrate-v1' });
  return Object.freeze({
    status: 'migrated',
    id: revision.id,
    revision: revision.revision,
    backupPath,
    adminSecretPath: preparedAdmin.secretPath,
  });
}
