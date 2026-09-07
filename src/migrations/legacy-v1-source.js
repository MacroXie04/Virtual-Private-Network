import { lstat } from 'node:fs/promises';
import { readBoundedFileNoFollow, readSecretFile } from '../state/bootstrap-files.js';
import { parseLegacyEnvironment, extractLegacyConfig } from './legacy-v1-parse.js';
import { buildMigratedState } from './legacy-v1-state.js';
import { MigrationError } from './migration-errors.js';

export function isMissing(error) {
  return error?.code === 'ENOENT';
}

export async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function detectLegacyV1({ envPath, configPath }) {
  return (await pathExists(envPath)) || (await pathExists(configPath));
}

export async function inspectLegacyV1({ envPath, configPath, fallbackEnvironment = {} }) {
  if (!(await pathExists(envPath)) || !(await pathExists(configPath))) {
    throw new MigrationError('INCOMPLETE_LEGACY_STATE', 'both legacy environment and configuration files are required');
  }
  const [environmentBytes, configBytes] = await Promise.all([
    readBoundedFileNoFollow(envPath, { maxBytes: 64 * 1024, description: 'legacy environment' }),
    readBoundedFileNoFollow(configPath, { maxBytes: 1024 * 1024, description: 'legacy configuration' }),
  ]);
  const legacyEnvironment = parseLegacyEnvironment(environmentBytes.toString('utf8'));
  let parsedConfig;
  try {
    parsedConfig = JSON.parse(configBytes.toString('utf8'));
  } catch {
    throw new MigrationError('INVALID_LEGACY_CONFIG', 'legacy configuration is not valid JSON');
  }
  const legacyConfig = extractLegacyConfig(parsedConfig);
  const preview = buildMigratedState({
    legacyEnvironment,
    legacyConfig,
    fallbackEnvironment,
    now: '2000-01-01T00:00:00.000Z',
  }).state;
  return {
    envPath,
    configPath,
    environmentBytes,
    configBytes,
    legacyEnvironment,
    legacyConfig,
    summary: Object.freeze({
      vpnPublicHostname: preview.gateway.vpnPublicHostname,
      subscriptionPublicBaseUrl: preview.gateway.subscriptionPublicBaseUrl,
      adminPublicHostname: preview.gateway.adminPublicHostname,
      egressHealthHost: preview.health.target.host,
      tailscaleHostname: preview.tailscale.hostname,
      tailscaleStateDirectory: preview.tailscale.stateDirectory,
      exitNode: preview.tailscale.exitNode,
      userId: preview.users[0].id,
      displayName: preview.users[0].displayName,
    }),
  };
}

export async function resolveMigrationApiKey(env, inspection) {
  if (env.TS_API_KEY_FILE) {
    return readSecretFile(env.TS_API_KEY_FILE, { description: 'Tailscale API-key file' });
  }
  return inspection.legacyEnvironment.TS_API_KEY || null;
}
