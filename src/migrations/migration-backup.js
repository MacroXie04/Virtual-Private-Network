import path from 'node:path';
import { chmod, lstat, mkdir, rmdir, unlink } from 'node:fs/promises';
import { writePrivateFileExclusive, isMissing } from '../state/bootstrap-files.js';
import { digest } from './migration-lineage-record.js';
import { MigrationError } from './migration-errors.js';

export async function createLegacyBackup({ dataDir, inspection, timestamp, randomBytesImpl }) {
  const backupRoot = path.join(dataDir, 'legacy-backups');
  const rootStat = await lstat(backupRoot).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (rootStat === null) await mkdir(backupRoot, { mode: 0o700 });
  else if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new MigrationError('UNSAFE_BACKUP_PATH', 'legacy backup root is unsafe');
  }
  await chmod(backupRoot, 0o700);
  const random = randomBytesImpl(4);
  if (!Buffer.isBuffer(random) || random.length !== 4) {
    throw new MigrationError('RANDOM_SOURCE_FAILED', 'legacy backup identifier could not be generated');
  }
  const name = `v1-${timestamp.replaceAll(':', '').replaceAll('.', '-')}-${random.toString('hex')}`;
  const backupPath = path.join(backupRoot, name);
  await mkdir(backupPath, { mode: 0o700 });
  try {
    await writePrivateFileExclusive(path.join(backupPath, 'environment.env'), inspection.environmentBytes);
    await writePrivateFileExclusive(path.join(backupPath, 'sing-box.json'), inspection.configBytes);
    const manifest = {
      schemaVersion: 1,
      migratedAt: timestamp,
      sources: {
        environment: {
          path: inspection.envPath,
          sha256: digest(inspection.environmentBytes),
          size: inspection.environmentBytes.length,
        },
        config: {
          path: inspection.configPath,
          sha256: digest(inspection.configBytes),
          size: inspection.configBytes.length,
        },
      },
    };
    await writePrivateFileExclusive(
      path.join(backupPath, 'manifest.json'),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    );
  } catch (error) {
    for (const file of ['manifest.json', 'sing-box.json', 'environment.env']) {
      await unlink(path.join(backupPath, file)).catch(() => {});
    }
    await rmdir(backupPath).catch(() => {});
    throw error;
  }
  return backupPath;
}
