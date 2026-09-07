import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { readBoundedFileNoFollow, isMissing } from '../state/bootstrap-files.js';
import { validateAbsoluteStatePath } from '../core/validation.js';
import { pathExists } from './legacy-v1-source.js';
import { MIGRATION_DIGEST, digest, migrationLineageError } from './migration-lineage-record.js';

async function readPrivateMigrationMarker(markerPath, description, maxBytes) {
  const stat = await lstat(markerPath).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (stat === null
      || stat.isSymbolicLink()
      || !stat.isFile()
      || stat.nlink !== 1
      || stat.uid !== (process.geteuid?.() ?? process.getuid?.() ?? 0)
      || (stat.mode & 0o777) !== 0o600) {
    throw migrationLineageError(`${description} is missing or unsafe`);
  }
  const bytes = await readBoundedFileNoFollow(markerPath, {
    maxBytes,
    requirePrivate: true,
    description,
  });
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.includes('\r') || text.includes('\0')) {
    throw migrationLineageError(`${description} is not canonical`);
  }
  return text.slice(0, -1);
}

async function assertEmptyPrivateMigrationMarker(markerPath, description) {
  const stat = await lstat(markerPath).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (stat === null
      || stat.isSymbolicLink()
      || !stat.isFile()
      || stat.nlink !== 1
      || stat.uid !== (process.geteuid?.() ?? process.getuid?.() ?? 0)
      || (stat.mode & 0o777) !== 0o600
      || stat.size !== 0) {
    throw migrationLineageError(`${description} is missing or unsafe`);
  }
}

export async function authenticateLegacyMigrationMarker({ dataDir, markerDir, inspection }) {
  if (!markerDir) return null;
  const normalizedMarkerDir = validateAbsoluteStatePath(markerDir, 'MIGRATION_MARKER_DIR');
  if (normalizedMarkerDir !== path.join(dataDir, '.legacy-migration-in-progress')) {
    throw migrationLineageError('legacy migration marker path is not canonical');
  }
  const markerStat = await lstat(normalizedMarkerDir).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (markerStat === null
      || markerStat.isSymbolicLink()
      || !markerStat.isDirectory()
      || markerStat.uid !== (process.geteuid?.() ?? process.getuid?.() ?? 0)
      || (markerStat.mode & 0o777) !== 0o700) {
    throw migrationLineageError('legacy migration marker directory is missing or unsafe');
  }
  const [envDigest, configDigest, sourceState] = await Promise.all([
    readPrivateMigrationMarker(path.join(normalizedMarkerDir, 'env.sha256'), 'legacy environment digest', 65),
    readPrivateMigrationMarker(path.join(normalizedMarkerDir, 'config.sha256'), 'legacy config digest', 65),
    readPrivateMigrationMarker(path.join(normalizedMarkerDir, 'source-state'), 'legacy state source marker', 4096),
  ]);
  if (!MIGRATION_DIGEST.test(envDigest) || envDigest !== digest(inspection.environmentBytes)) {
    throw migrationLineageError('legacy environment does not match the approved migration marker');
  }
  if (!MIGRATION_DIGEST.test(configDigest) || configDigest !== digest(inspection.configBytes)) {
    throw migrationLineageError('legacy configuration does not match the approved migration marker');
  }
  if (sourceState !== validateAbsoluteStatePath(
    inspection.legacyConfig.stateDirectory,
    'legacy.stateDirectory',
  )) {
    throw migrationLineageError('legacy Tailscale state does not match the approved migration marker');
  }
  await assertEmptyPrivateMigrationMarker(
    path.join(normalizedMarkerDir, 'state-copied'),
    'legacy state-copied marker',
  );
  const statePublishedPath = path.join(normalizedMarkerDir, 'state-published');
  const statePublished = await pathExists(statePublishedPath);
  if (statePublished) {
    await assertEmptyPrivateMigrationMarker(statePublishedPath, 'legacy state-published marker');
  }
  if (await pathExists(path.join(normalizedMarkerDir, 'committed'))) {
    throw migrationLineageError('legacy migration marker is already committed');
  }
  return Object.freeze({
    directory: normalizedMarkerDir,
    lineagePath: path.join(normalizedMarkerDir, 'lineage.json'),
    statePublished,
  });
}
