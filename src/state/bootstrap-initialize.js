import path from 'node:path';
import { createAdminScryptRecord } from '../core/credentials.js';
import { STATE_SCHEMA_VERSION, validateState } from '../core/state-schema.js';
import { absolutePath, readSecretFile } from './bootstrap-files.js';
import {
  generateHealthCredentials,
  prepareAdminSecret,
  persistPreparedAdminSecret,
  generateWebSocketPath,
} from './bootstrap-credentials.js';
import {
  envString,
  envPort,
  resolveTime,
  ingressEnvironment,
  validateSingBoxPath,
} from './bootstrap-environment.js';
import { validateCandidateConfig } from './bootstrap-candidate.js';

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
