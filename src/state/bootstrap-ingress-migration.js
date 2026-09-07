import path from 'node:path';
import { STATE_SCHEMA_VERSION, validateState } from '../core/state-schema.js';
import { validateTimestamp } from '../core/validation.js';
import { readBoundedFileNoFollow, writePrivateFileExclusive } from './bootstrap-files.js';
import { generateWebSocketPath } from './bootstrap-credentials.js';
import { resolveTime, ingressEnvironment } from './bootstrap-environment.js';
import { validateCandidateConfig } from './bootstrap-candidate.js';
import { BootstrapError } from './bootstrap-errors.js';

export function buildIngressMigrationState(current, settings, websocketPath, timestamp) {
  if (!current?.requiresIngressMigration || current.state?.schemaVersion !== 2) {
    throw new BootstrapError('MIGRATION_SOURCE_INVALID', 'schema-v2 REALITY state is required');
  }
  const updatedAt = timestamp < current.state.updatedAt ? current.state.updatedAt : timestamp;
  return validateState({
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: current.state.revision + 1,
    createdAt: current.state.createdAt,
    updatedAt,
    gateway: { ...settings.gateway, websocketPath },
    tailscale: current.state.tailscale,
    health: {
      ...current.state.health,
      target: { host: settings.egressHealthHost, port: 443 },
    },
    admin: current.state.admin,
    users: current.state.users,
  });
}

function migrationCandidateMatches(current, candidate, settings) {
  const state = candidate.state;
  return candidate.requiresIngressMigration === false
    && candidate.manifest.operation === 'ingress.migrate'
    && state.schemaVersion === STATE_SCHEMA_VERSION
    && state.revision === current.state.revision + 1
    && state.createdAt === current.state.createdAt
    && JSON.stringify(state.users) === JSON.stringify(current.state.users)
    && JSON.stringify(state.admin) === JSON.stringify(current.state.admin)
    && JSON.stringify(state.tailscale) === JSON.stringify(current.state.tailscale)
    && JSON.stringify({ ...state.gateway, websocketPath: null })
      === JSON.stringify({ ...settings.gateway, websocketPath: null })
    && state.health.listenPort === current.state.health.listenPort
    && state.health.username === current.state.health.username
    && state.health.password === current.state.health.password
    && state.health.target.host === settings.egressHealthHost
    && state.health.target.port === 443;
}

async function findIngressMigrationRevision(repository, current, settings) {
  const prefix = `${String(current.state.revision + 1).padStart(16, '0')}-`;
  const revisions = await repository.listRevisions();
  let matched = null;
  for (const record of revisions) {
    if (!record.id.startsWith(prefix)) continue;
    const candidate = await repository.readRevision(record.id);
    if (
      candidate.manifest.operation !== 'ingress.migrate'
      || !migrationCandidateMatches(current, candidate, settings)
      || matched !== null
    ) {
      throw new BootstrapError('MIGRATION_CONFLICT', 'an incompatible ingress migration revision already exists');
    }
    matched = candidate;
  }
  return matched;
}

async function ensureMaintenanceMarker(dataDir, timestamp) {
  const markerPath = path.join(dataDir, 'maintenance');
  try {
    await writePrivateFileExclusive(markerPath, Buffer.from(`${timestamp}\n`, 'utf8'));
  } catch (error) {
    if (error?.code !== 'FILE_EXISTS') throw error;
    const existing = (await readBoundedFileNoFollow(markerPath, {
      maxBytes: 64,
      requirePrivate: true,
      description: 'maintenance marker',
    })).toString('utf8').trim();
    validateTimestamp(existing, 'maintenanceMarker');
  }
}

export async function stageIngressMigration(current, {
  repository,
  dataDir,
  env,
  singBoxPath,
  execFileImpl,
  validateConfigImpl,
  randomBytesImpl,
  now,
  apply,
}) {
  const preliminary = ingressEnvironment(env);
  let candidate = await findIngressMigrationRevision(repository, current, preliminary);
  const websocketPath = preliminary.gateway.websocketPath
    ?? candidate?.state.gateway.websocketPath
    ?? generateWebSocketPath(randomBytesImpl);
  if (candidate && env.WS_PATH && candidate.state.gateway.websocketPath !== env.WS_PATH) {
    throw new BootstrapError('MIGRATION_CONFLICT', 'WS_PATH does not match the staged ingress migration');
  }
  const state = candidate?.state ?? buildIngressMigrationState(
    current,
    preliminary,
    websocketPath,
    resolveTime(now),
  );
  await validateCandidateConfig(state, {
    dataDir,
    singBoxPath,
    execFileImpl,
    validateConfigImpl,
  });
  if (!apply) {
    return Object.freeze({
      status: 'migration-dry-run',
      id: current.id,
      revision: current.state.revision,
      candidateRevision: state.revision,
    });
  }
  if (candidate === null) {
    const created = await repository.createRevision(state, { operation: 'ingress.migrate' });
    candidate = await repository.readRevision(created.id);
  }
  // The immutable candidate is harmless until selected. Publish maintenance
  // before switching the runtime pointer so subscriptions can never race the
  // WebSocket cutover.
  await ensureMaintenanceMarker(dataDir, resolveTime(now));
  await repository.activateRuntime(candidate.id);
  return Object.freeze({
    status: 'migration-staged',
    id: candidate.id,
    revision: candidate.state.revision,
    previousId: current.id,
  });
}
