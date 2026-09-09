import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { renderSingBoxConfig } from '../../core/server/render.js';
import { validateSingBoxConfig } from '../../runtime/sing-box/config-check.js';
import { ValidationError } from '../../core/validation/values.js';
import {
  isMissing,
  syncDirectory,
  writePrivateFileExclusive,
  absolutePath,
  readSecretFile,
} from './secrets/files.js';
import { validateSingBoxPath, envString, envPort, resolveTime, ingressEnvironment } from './environment.js';
import { BootstrapError } from './errors.js';
import { createAdminScryptRecord } from '../../core/identity/credentials.js';
import { STATE_SCHEMA_VERSION } from '../../core/model/policy.js';
import { validateState } from '../../core/model/state.js';
import {
  generateHealthCredentials,
  prepareAdminSecret,
  persistPreparedAdminSecret,
  generateWebSocketPath,
} from './secrets/credentials.js';

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

export async function initializeBootstrap({
  repo, dataDir, env, execFileImpl, validateConfigImpl, randomBytesImpl, now,
}) {
  const singBoxPath = validateSingBoxPath(env.SINGBOX_BIN ?? '/usr/local/bin/sing-box');
  const ingress = ingressEnvironment(env);
  const authKeyPath = envString(env, 'TS_AUTH_KEY_FILE');
  const authKey = await readSecretFile(absolutePath(authKeyPath, 'TS_AUTH_KEY_FILE'), {
    description: 'Tailscale auth-key file',
  });
  const apiKeyPath = envString(env, 'TS_API_KEY_FILE', { required: false });
  if (apiKeyPath !== null) {
    await readSecretFile(absolutePath(apiKeyPath, 'TS_API_KEY_FILE'), {
      description: 'Tailscale API-key file',
    });
  }
  const timestamp = resolveTime(now);
  const preparedAdmin = await prepareAdminSecret(dataDir, { randomBytesImpl });
  const adminRecord = await createAdminScryptRecord(preparedAdmin.secret, { randomBytesImpl });
  const healthCredentials = generateHealthCredentials(randomBytesImpl);
  const state = validateState({
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    gateway: {
      ...ingress.gateway,
      websocketPath: ingress.gateway.websocketPath ?? generateWebSocketPath(randomBytesImpl),
    },
    tailscale: {
      hostname: envString(env, 'TS_HOSTNAME', { fallback: env.NODE_NAME ?? 'vps-ws' }),
      stateDirectory: absolutePath(
        env.SINGBOX_STATE_DIR ?? path.join(dataDir, 'tailscale'),
        'SINGBOX_STATE_DIR',
      ),
      authKey,
      // The controller rereads this root-only file for every directory query;
      // never copy a fresh API credential into immutable revision history.
      apiKey: null,
      exitNode: envString(env, 'EXIT_NODE'),
    },
    health: {
      listenPort: envPort(env, ['HEALTH_PORT'], 19080),
      ...healthCredentials,
      target: {
        // Exercise both exit-routed DNS and TCP connectivity during readiness.
        host: ingress.egressHealthHost,
        port: 443,
      },
    },
    admin: { scrypt: adminRecord },
    // Subscription credentials are one-time values. Fresh installs deliberately
    // start empty so the first token is created and displayed only by the
    // authenticated admin workflow, never by a service log or bootstrap file.
    users: [],
  });

  await validateCandidateConfig(state, {
    dataDir,
    singBoxPath,
    execFileImpl,
    validateConfigImpl,
  });
  await persistPreparedAdminSecret(preparedAdmin);
  const revision = await repo.initialize(state, { operation: 'bootstrap' });
  return Object.freeze({
    status: 'initialized',
    id: revision.id,
    revision: revision.revision,
    adminSecretPath: preparedAdmin.secretPath,
  });
}
