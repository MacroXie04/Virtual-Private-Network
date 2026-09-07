import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { renderSingBoxConfig } from '../core/server-render.js';
import { validateSingBoxConfig } from '../runtime/runtime.js';
import { ValidationError } from '../core/validation.js';
import { isMissing, syncDirectory, writePrivateFileExclusive } from './bootstrap-files.js';
import { validateSingBoxPath } from './bootstrap-environment.js';
import { BootstrapError } from './bootstrap-errors.js';

export const execFileAsync = promisify(execFileCallback);

export async function validateCandidateConfig(state, {
  dataDir,
  singBoxPath = '/usr/local/bin/sing-box',
  execFileImpl = execFileAsync,
  validateConfigImpl = validateSingBoxConfig,
} = {}) {
  const config = renderSingBoxConfig(state);
  const executable = validateSingBoxPath(singBoxPath);
  const candidatePath = path.join(dataDir, `.bootstrap-config-${randomUUID()}.json`);
  try {
    await writePrivateFileExclusive(candidatePath, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));
    await validateConfigImpl(candidatePath, { singBoxPath: executable, execFile: execFileImpl });
  } catch (error) {
    if (error instanceof BootstrapError || error instanceof ValidationError) throw error;
    throw new BootstrapError('CONFIG_REJECTED', 'sing-box rejected the bootstrap configuration');
  } finally {
    await unlink(candidatePath).catch((error) => {
      if (!isMissing(error)) throw error;
    });
    await syncDirectory(dataDir).catch(() => {});
  }
  return config;
}
