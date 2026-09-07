import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateSingBoxConfig } from '../runtime/runtime.js';
import { absolutePath } from './bootstrap-files.js';
import { resolveRepository, validateSingBoxPath } from './bootstrap-environment.js';
import { execFileAsync } from './bootstrap-candidate.js';
import { cleanupBootstrapConfigOrphans, assertNoUnpointedRevision } from './bootstrap-recovery.js';
import { BootstrapError } from './bootstrap-errors.js';
import { resumeExistingBootstrap } from './bootstrap-existing.js';
import { initializeBootstrap } from './bootstrap-initialize.js';
import { detectLegacyV1 } from '../migrations/legacy-v1-source.js';
import { migrateLegacyV1 } from '../migrations/migrate-v1.js';

export async function bootstrap({
  env = process.env,
  repository = null,
  execFileImpl = execFileAsync,
  validateConfigImpl = validateSingBoxConfig,
  randomBytesImpl = randomBytes,
  now = () => new Date(),
  migrationMode,
  realityMigrationMode,
} = {}) {
  const dataDir = absolutePath(env.DATA_DIR ?? '/var/lib/vpn-gateway', 'DATA_DIR');
  const repo = resolveRepository(env, dataDir, repository);
  const existing = await resumeExistingBootstrap({
    repo, dataDir, env, execFileImpl, validateConfigImpl, randomBytesImpl, now, realityMigrationMode,
  });
  if (existing !== null) return existing;

  const expectedConfigPath = path.join(dataDir, 'runtime', 'sing-box.json');
  const configuredPath = absolutePath(env.SINGBOX_CONFIG ?? expectedConfigPath, 'SINGBOX_CONFIG');
  if (configuredPath !== expectedConfigPath) {
    throw new BootstrapError('INVALID_RUNTIME_PATH', 'SINGBOX_CONFIG must address the repository runtime revision');
  }

  const legacyEnvPath = absolutePath(env.LEGACY_ENV_FILE ?? path.join(dataDir, 'env'), 'LEGACY_ENV_FILE');
  const legacyConfigPath = absolutePath(
    env.LEGACY_CONFIG_FILE ?? path.join(dataDir, 'config.json'),
    'LEGACY_CONFIG_FILE',
  );
  if (await detectLegacyV1({ envPath: legacyEnvPath, configPath: legacyConfigPath })) {
    const mode = migrationMode ?? env.MIGRATE_LEGACY ?? 'required';
    if (!['1', 'apply', 'dry-run'].includes(mode)) {
      throw new BootstrapError(
        'LEGACY_MIGRATION_REQUIRED',
        'legacy state was detected; review a dry run and set MIGRATE_LEGACY=1 to apply it',
      );
    }
    const apply = mode === '1' || mode === 'apply';
    if (apply) {
      await repo.ensure();
      await repo.cleanupInterruptedWrites?.();
      await cleanupBootstrapConfigOrphans(dataDir);
    }
    return migrateLegacyV1({
      apply,
      dataDir,
      envPath: legacyEnvPath,
      configPath: legacyConfigPath,
      env,
      repository: repo,
      execFileImpl,
      validateConfigImpl,
      randomBytesImpl,
      now,
      singBoxPath: validateSingBoxPath(env.SINGBOX_BIN ?? '/usr/local/bin/sing-box'),
    });
  }

  await assertNoUnpointedRevision(dataDir);

  // Fresh initialization needs a private parent for the temporary semantic
  // validation file. Keep this after legacy detection so dry-run migration is
  // genuinely read-only with respect to the v2 state tree.
  await repo.ensure();
  await repo.cleanupInterruptedWrites?.();
  await cleanupBootstrapConfigOrphans(dataDir);

  return initializeBootstrap({
    repo, dataDir, env, execFileImpl, validateConfigImpl, randomBytesImpl, now,
  });
}
