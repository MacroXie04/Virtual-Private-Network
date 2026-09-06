import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  open,
  readdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  createAdminScryptRecord,
} from '../core/credentials.js';
import { renderSingBoxConfig } from '../core/render.js';
import { RevisionRepository } from './repository.js';
import { validateSingBoxConfig } from '../runtime/runtime.js';
import {
  HEALTH_PASSWORD_BYTES,
  HEALTH_USERNAME,
  STATE_SCHEMA_VERSION,
  validateState,
} from '../core/state-schema.js';
import {
  ValidationError,
  validateAbsoluteStatePath,
  validatePort,
  validatePublicDnsHostname,
  validatePublicIngressSettings,
  validateTimestamp,
  validateWebSocketPath,
} from '../core/validation.js';

const execFileAsync = promisify(execFileCallback);
const NOFOLLOW = fsConstants.O_NOFOLLOW;
const DIRECTORY = fsConstants.O_DIRECTORY;
const ADMIN_SECRET_BYTES = 32;
const SECRET_FILE_MAX_BYTES = 1024;
const BOOTSTRAP_CONFIG_ID = /^\.bootstrap-config-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;
const PERSISTED_REVISION_ID = /^[0-9]{16}-[0-9a-f]{16}$/u;

export class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
  }
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function absolutePath(value, name) {
  const validated = validateAbsoluteStatePath(value, name);
  if (path.normalize(validated) !== validated) {
    throw new ValidationError(name, 'must be normalized');
  }
  return validated;
}

async function safeLstat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function readBoundedFileNoFollow(filePath, {
  maxBytes = SECRET_FILE_MAX_BYTES,
  requirePrivate = false,
  description = 'file',
} = {}) {
  const normalizedPath = absolutePath(filePath, `${description}Path`);
  let handle;
  try {
    handle = await open(normalizedPath, fsConstants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) {
      throw new BootstrapError('UNSAFE_FILE', `${description} must be a bounded regular file`);
    }
    if (requirePrivate && ((stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid())) {
      throw new BootstrapError(
        'UNSAFE_PERMISSIONS',
        `${description} must be owned by the current service identity and not accessible by group or other users`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > maxBytes) {
      throw new BootstrapError('UNSAFE_FILE', `${description} changed while being read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof BootstrapError || error instanceof ValidationError) throw error;
    if (isMissing(error)) throw new BootstrapError('FILE_NOT_FOUND', `${description} is missing`);
    throw new BootstrapError('UNSAFE_FILE', `${description} could not be read safely`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readSecretFile(filePath, options = {}) {
  const bytes = await readBoundedFileNoFollow(filePath, {
    ...options,
    maxBytes: options.maxBytes ?? SECRET_FILE_MAX_BYTES,
    requirePrivate: true,
    description: options.description ?? 'secret file',
  });
  let value = bytes.toString('utf8');
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.length < (options.minLength ?? 8)
    || value.length > (options.maxLength ?? 512)
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new BootstrapError('INVALID_SECRET', `${options.description ?? 'secret file'} has invalid content`);
  }
  return value;
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Remove crash-orphaned semantic-check files before readiness is possible. */
export async function cleanupBootstrapConfigOrphans(dataDir) {
  const normalizedDirectory = absolutePath(dataDir, 'DATA_DIR');
  const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
  let directoryHandle;
  let entries;
  try {
    const before = await lstat(normalizedDirectory);
    directoryHandle = await open(normalizedDirectory, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const opened = await directoryHandle.stat();
    if (
      !opened.isDirectory()
      || opened.uid !== expectedUid
      || (opened.mode & 0o022) !== 0
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new BootstrapError('UNSAFE_FILE', 'bootstrap data directory is unsafe');
    }
    entries = await readdir(normalizedDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError('UNSAFE_FILE', 'bootstrap data directory could not be inspected safely');
  } finally {
    await directoryHandle?.close().catch(() => {});
  }

  let removed = 0;
  for (const entry of entries) {
    if (!BOOTSTRAP_CONFIG_ID.test(entry.name)) continue;
    const candidatePath = path.join(normalizedDirectory, entry.name);
    let handle;
    try {
      const before = await lstat(candidatePath);
      handle = await open(candidatePath, fsConstants.O_RDONLY | NOFOLLOW);
      const stat = await handle.stat();
      if (
        !entry.isFile()
        || !stat.isFile()
        || stat.nlink !== 1
        || stat.uid !== expectedUid
        || (stat.mode & 0o777) !== 0o600
        || stat.size > 4 * 1024 * 1024
        || stat.dev !== before.dev
        || stat.ino !== before.ino
      ) {
        throw new BootstrapError('UNSAFE_FILE', 'crash-orphaned bootstrap configuration is unsafe');
      }
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      throw new BootstrapError('UNSAFE_FILE', 'crash-orphaned bootstrap configuration could not be inspected safely');
    } finally {
      await handle?.close().catch(() => {});
    }
    await unlink(candidatePath);
    removed += 1;
  }
  if (removed > 0) await syncDirectory(normalizedDirectory);
  return removed;
}

/** Refuse to mint a second authority over a committed but unpointed revision. */
export async function assertNoUnpointedRevision(dataDir) {
  const normalizedDirectory = absolutePath(dataDir, 'DATA_DIR');
  const revisionsPath = path.join(normalizedDirectory, 'revisions');
  const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
  const before = await safeLstat(revisionsPath);
  if (before === null) return;

  let handle;
  try {
    handle = await open(revisionsPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.uid !== expectedUid
      || (opened.mode & 0o022) !== 0
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new BootstrapError('UNSAFE_FILE', 'revision directory is unsafe');
    }
    const entries = await readdir(revisionsPath, { withFileTypes: true });
    const after = await lstat(revisionsPath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || !after.isDirectory()) {
      throw new BootstrapError('UNSAFE_FILE', 'revision directory changed while being inspected');
    }
    if (entries.some((entry) => PERSISTED_REVISION_ID.test(entry.name))) {
      throw new BootstrapError(
        'ORPHANED_REVISION',
        'committed revisions exist without an authoritative pointer; restore a verified current or runtime pointer from backup',
      );
    }
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError('UNSAFE_FILE', 'revision directory could not be inspected safely');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writePrivateFileExclusive(filePath, bytes) {
  const normalizedPath = absolutePath(filePath, 'privateFilePath');
  let handle;
  try {
    handle = await open(
      normalizedPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new BootstrapError('FILE_EXISTS', 'private bootstrap file already exists');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  await syncDirectory(path.dirname(normalizedPath));
}

function secureRandom(size, randomBytesImpl, description) {
  const value = randomBytesImpl(size);
  if (!Buffer.isBuffer(value) || value.length !== size) {
    throw new BootstrapError('RANDOM_SOURCE_FAILED', `${description} could not be generated securely`);
  }
  return value;
}

/** Generate the private credentials for the loopback-only health SOCKS inbound. */
export function generateHealthCredentials(randomBytesImpl = randomBytes) {
  return Object.freeze({
    username: HEALTH_USERNAME,
    password: secureRandom(
      HEALTH_PASSWORD_BYTES,
      randomBytesImpl,
      'health probe password',
    ).toString('base64url'),
  });
}

function canonicalAdminSecret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new BootstrapError('INVALID_ADMIN_SECRET', 'administrator secret file has invalid content');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== ADMIN_SECRET_BYTES || decoded.toString('base64url') !== value) {
    throw new BootstrapError('INVALID_ADMIN_SECRET', 'administrator secret file has invalid content');
  }
  return value;
}

export async function prepareAdminSecret(dataDir, { randomBytesImpl = randomBytes } = {}) {
  const secretPath = path.join(dataDir, 'admin-secret');
  const stat = await safeLstat(secretPath);
  if (stat !== null) {
    const secret = canonicalAdminSecret(await readSecretFile(secretPath, {
      description: 'administrator secret file',
      minLength: 43,
      maxLength: 43,
      maxBytes: 64,
    }));
    return { secret, secretPath, needsWrite: false };
  }
  return {
    secret: secureRandom(ADMIN_SECRET_BYTES, randomBytesImpl, 'administrator secret').toString('base64url'),
    secretPath,
    needsWrite: true,
  };
}

export async function persistPreparedAdminSecret(prepared) {
  if (prepared.needsWrite) {
    await writePrivateFileExclusive(prepared.secretPath, Buffer.from(`${prepared.secret}\n`, 'utf8'));
  }
}

function validateSingBoxPath(value) {
  const binaryPath = absolutePath(value, 'SINGBOX_BIN');
  if (path.basename(binaryPath) !== 'sing-box') {
    throw new ValidationError('SINGBOX_BIN', 'must name the sing-box executable');
  }
  return binaryPath;
}

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

function envString(env, name, { required = true, fallback } = {}) {
  const value = env[name] === undefined || env[name] === '' ? fallback : env[name];
  if (value === undefined || value === null || value === '') {
    if (required) throw new BootstrapError('MISSING_CONFIGURATION', `${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ValidationError(name, 'must be a non-empty string without control characters');
  }
  return value;
}

function envPort(env, names, fallback) {
  const name = names.find((candidate) => env[candidate] !== undefined && env[candidate] !== '');
  if (name === undefined) return validatePort(fallback, names[0]);
  const raw = env[name];
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,4}$/u.test(raw)) {
    throw new ValidationError(name, 'must be a decimal TCP port');
  }
  return validatePort(Number(raw), name);
}

function optionalGid(env, name) {
  if (env[name] === undefined || env[name] === '') return null;
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(env[name])) throw new ValidationError(name, 'must be a gid');
  const gid = Number(env[name]);
  if (!Number.isSafeInteger(gid) || gid > 2_147_483_647) throw new ValidationError(name, 'must be a gid');
  return gid;
}

function resolveTime(now) {
  const value = typeof now === 'function' ? now() : now;
  return validateTimestamp(value instanceof Date ? value.toISOString() : value, 'now');
}

function resolveRepository(env, dataDir, repository) {
  if (repository) return repository;
  return new RevisionRepository(dataDir, {
    runtimeGid: optionalGid(env, 'SINGBOX_GID'),
    subscriptionGid: optionalGid(env, 'SUB_GID'),
    // This process runs before any service is published and is the only place
    // allowed to recognize the immediately previous REALITY schema.
    allowLegacyMigration: true,
  });
}

export function generateWebSocketPath(randomBytesImpl = randomBytes) {
  return `/${secureRandom(32, randomBytesImpl, 'WebSocket path').toString('base64url')}`;
}

function ingressEnvironment(env, websocketPath = null) {
  const configuredPath = env.WS_PATH === undefined || env.WS_PATH === ''
    ? websocketPath
    : validateWebSocketPath(envString(env, 'WS_PATH'), 'WS_PATH');
  const gateway = validatePublicIngressSettings({
    vpnPublicHostname: envString(env, 'VPN_PUBLIC_HOSTNAME'),
    subscriptionPublicBaseUrl: envString(env, 'SUBSCRIPTION_PUBLIC_BASE_URL'),
    adminPublicHostname: envString(env, 'ADMIN_PUBLIC_HOSTNAME'),
    websocketPath: configuredPath ?? `/${'A'.repeat(43)}`,
  }, 'gateway');
  return {
    gateway: configuredPath === null ? { ...gateway, websocketPath: null } : gateway,
    egressHealthHost: validatePublicDnsHostname(
      envString(env, 'EGRESS_HEALTH_HOST'),
      'EGRESS_HEALTH_HOST',
    ),
  };
}

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

async function stageIngressMigration(current, {
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
  const migration = await import('../migrations/migrate-v1.js');
  if (await migration.detectLegacyV1({ envPath: legacyEnvPath, configPath: legacyConfigPath })) {
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
    return migration.migrateLegacyV1({
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap().then((result) => {
    const verb = result.status === 'existing'
      ? 'Using'
      : result.status === 'recovered'
        ? 'Recovered'
        : result.status === 'migration-staged'
          ? 'Staged migration for'
          : result.status === 'migration-dry-run'
            ? 'Validated migration from'
          : 'Initialized';
    process.stdout.write(`${verb} VPN gateway state revision ${result.revision}.\n`);
  }).catch((error) => {
    process.stderr.write(`VPN gateway bootstrap failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
