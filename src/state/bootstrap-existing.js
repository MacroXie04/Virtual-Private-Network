import path from 'node:path';
import { safeLstat } from './bootstrap-files.js';
import { validateSingBoxPath } from './bootstrap-environment.js';
import { cleanupBootstrapConfigOrphans } from './bootstrap-recovery.js';
import { stageIngressMigration } from './bootstrap-ingress-migration.js';
import { BootstrapError } from './bootstrap-errors.js';

export async function resumeExistingBootstrap({
  repo, dataDir, env, execFileImpl, validateConfigImpl, randomBytesImpl, now, realityMigrationMode,
}) {
  const statePointerPresent = (await safeLstat(path.join(dataDir, 'current'))) !== null
    || (await safeLstat(path.join(dataDir, 'runtime'))) !== null;
  if (statePointerPresent) {
    let current = await repo.readCurrent();
    if (current !== null) {
      await repo.cleanupInterruptedWrites?.();
      await cleanupBootstrapConfigOrphans(dataDir);
      const runtimeId = await repo.readPointer('runtime');
      if (current.requiresIngressMigration) {
        const mode = realityMigrationMode ?? env.MIGRATE_REALITY ?? 'required';
        if (!['1', 'apply', 'dry-run'].includes(mode)) {
          throw new BootstrapError(
            'REALITY_MIGRATION_REQUIRED',
            'schema-v2 REALITY state requires an explicit MIGRATE_REALITY=1 cutover',
          );
        }
        return stageIngressMigration(current, {
          repository: repo,
          dataDir,
          env,
          singBoxPath: validateSingBoxPath(env.SINGBOX_BIN ?? '/usr/local/bin/sing-box'),
          execFileImpl,
          validateConfigImpl,
          randomBytesImpl,
          now,
          apply: mode === '1' || mode === 'apply',
        });
      }
      if (runtimeId !== current.id) await repo.activateRuntime(current.id);
      return Object.freeze({
        status: runtimeId === current.id ? 'existing' : 'recovered',
        id: current.id,
        revision: current.state.revision,
      });
    }
    const interruptedRuntime = await repo.readRuntime();
    if (interruptedRuntime !== null) {
      if (interruptedRuntime.manifest.operation === 'ingress.migrate') {
        throw new BootstrapError(
          'MIGRATION_AUTHORITY_LOST',
          'staged ingress migration has no current source pointer; restore the verified schema-v2 pointer',
        );
      }
      await repo.activateCurrent(interruptedRuntime.id);
      await repo.cleanupInterruptedWrites?.();
      await cleanupBootstrapConfigOrphans(dataDir);
      if (interruptedRuntime.requiresIngressMigration) {
        const mode = realityMigrationMode ?? env.MIGRATE_REALITY ?? 'required';
        if (!['1', 'apply', 'dry-run'].includes(mode)) {
          throw new BootstrapError(
            'REALITY_MIGRATION_REQUIRED',
            'schema-v2 REALITY state requires an explicit MIGRATE_REALITY=1 cutover',
          );
        }
        return stageIngressMigration(interruptedRuntime, {
          repository: repo,
          dataDir,
          env,
          singBoxPath: validateSingBoxPath(env.SINGBOX_BIN ?? '/usr/local/bin/sing-box'),
          execFileImpl,
          validateConfigImpl,
          randomBytesImpl,
          now,
          apply: mode === '1' || mode === 'apply',
        });
      }
      return Object.freeze({
        status: 'recovered',
        id: interruptedRuntime.id,
        revision: interruptedRuntime.state.revision,
      });
    }
  }

  return null;
}
