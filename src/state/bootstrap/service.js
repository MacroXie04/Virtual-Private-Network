import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateSingBoxConfig } from '../../runtime/sing-box/config-check.js';
import { absolutePath } from './secrets/files.js';
import { resolveRepository } from './environment.js';
import { execFileAsync, initializeBootstrap } from './initialize.js';
import {
  cleanupBootstrapConfigOrphans,
  assertNoUnpointedRevision,
  assertSupportedDataDirectory,
  resumeExistingBootstrap,
} from './recovery.js';
import { BootstrapError } from './errors.js';

export async function bootstrap({
  env = process.env,
  repository = null,
  execFileImpl = execFileAsync,
  validateConfigImpl = validateSingBoxConfig,
  randomBytesImpl = randomBytes,
  now = () => new Date(),
} = {}) {
  const dataDir = absolutePath(env.DATA_DIR ?? '/var/lib/vpn-gateway', 'DATA_DIR');
  await assertSupportedDataDirectory(dataDir);
  const repo = resolveRepository(env, dataDir, repository);
  const existing = await resumeExistingBootstrap({ repo, dataDir });
  if (existing !== null) return existing;

  const expectedConfigPath = path.join(dataDir, 'runtime', 'sing-box.json');
  const configuredPath = absolutePath(env.SINGBOX_CONFIG ?? expectedConfigPath, 'SINGBOX_CONFIG');
  if (configuredPath !== expectedConfigPath) {
    throw new BootstrapError('INVALID_RUNTIME_PATH', 'SINGBOX_CONFIG must address the repository runtime revision');
  }

  await assertNoUnpointedRevision(dataDir);

  // Fresh initialization needs a private parent for the temporary semantic
  // validation file, after all existing data has been checked without writes.
  await repo.ensure();
  await repo.cleanupInterruptedWrites?.();
  await cleanupBootstrapConfigOrphans(dataDir);

  return initializeBootstrap({
    repo, dataDir, env, execFileImpl, validateConfigImpl, randomBytesImpl, now,
  });
}
