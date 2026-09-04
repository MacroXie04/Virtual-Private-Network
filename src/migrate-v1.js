import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  BootstrapError,
  generateHealthCredentials,
  prepareAdminSecret,
  persistPreparedAdminSecret,
  readBoundedFileNoFollow,
  readSecretFile,
  validateCandidateConfig,
  writePrivateFileExclusive,
} from './bootstrap.js';
import {
  createAdminScryptRecord,
  hashSubscriptionToken,
} from './credentials.js';
import { RevisionRepository } from './repository.js';
import { validateState } from './state-schema.js';
import {
  ValidationError,
  classifyHost,
  isPlainObject,
  normalizeDisplayName,
  validateAbsoluteStatePath,
  validatePort,
  validateTimestamp,
} from './validation.js';

const LEGACY_ENV_KEYS = new Set([
  'EXIT_NODE',
  'LISTEN_PORT',
  'NODE_NAME',
  'NODE_PORT',
  'PUBLIC_BASE_URL',
  'PUBLIC_ORIGIN',
  'REALITY_PRIVATE_KEY',
  'REALITY_PUBLIC_KEY',
  'SERVER_NAME',
  'SHORT_ID',
  'SINGBOX_STATE_DIR',
  'SUB_TOKEN',
  'TS_API_KEY',
  'TS_AUTH_KEY',
  'TS_HOSTNAME',
  'UUID',
  'VPS_HOST',
]);

export class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function decodeLegacyValue(raw, lineNumber) {
  if (raw.startsWith('"')) {
    try {
      const value = JSON.parse(raw);
      if (typeof value !== 'string') throw new Error('not a string');
      return value;
    } catch {
      throw new MigrationError('INVALID_LEGACY_ENV', `legacy environment line ${lineNumber} has invalid quoting`);
    }
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'") || raw.slice(1, -1).includes("'")) {
      throw new MigrationError('INVALID_LEGACY_ENV', `legacy environment line ${lineNumber} has invalid quoting`);
    }
    return raw.slice(1, -1);
  }
  if (raw !== raw.trim()) {
    throw new MigrationError('INVALID_LEGACY_ENV', `legacy environment line ${lineNumber} has ambiguous whitespace`);
  }
  return raw;
}

export function parseLegacyEnvironment(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 64 * 1024 || text.includes('\0')) {
    throw new MigrationError('INVALID_LEGACY_ENV', 'legacy environment is invalid or too large');
  }
  const result = Object.create(null);
  const lines = text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !LEGACY_ENV_KEYS.has(match[1])) {
      throw new MigrationError('INVALID_LEGACY_ENV', `legacy environment line ${lineNumber} is not allowlisted`);
    }
    if (Object.hasOwn(result, match[1])) {
      throw new MigrationError('INVALID_LEGACY_ENV', `legacy environment key ${match[1]} is duplicated`);
    }
    const value = decodeLegacyValue(match[2], lineNumber);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
      throw new MigrationError('INVALID_LEGACY_ENV', `legacy environment key ${match[1]} contains control data`);
    }
    result[match[1]] = value;
  });
  return result;
}

function requireObject(value, description) {
  if (!isPlainObject(value)) throw new MigrationError('INVALID_LEGACY_CONFIG', `${description} is invalid`);
  return value;
}

function exactlyOne(values, predicate, description) {
  if (!Array.isArray(values)) throw new MigrationError('INVALID_LEGACY_CONFIG', `${description} is missing`);
  const found = values.filter(predicate);
  if (found.length !== 1) {
    throw new MigrationError('INVALID_LEGACY_CONFIG', `legacy configuration must contain exactly one ${description}`);
  }
  return requireObject(found[0], description);
}

function legacyString(value, description, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string' || value.length > 4096 || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new MigrationError('INVALID_LEGACY_CONFIG', `${description} is invalid`);
  }
  return value;
}

export function extractLegacyConfig(value) {
  const config = requireObject(value, 'legacy configuration');
  const inbound = exactlyOne(
    config.inbounds,
    (candidate) => candidate?.type === 'vless' && (candidate.tag === 'vless-in' || candidate.tag === undefined),
    'VLESS inbound',
  );
  const endpoint = exactlyOne(
    config.endpoints,
    (candidate) => candidate?.type === 'tailscale' && candidate.tag === 'ts-out',
    'ts-out Tailscale endpoint',
  );
  if (!Array.isArray(inbound.users) || inbound.users.length !== 1) {
    throw new MigrationError('INVALID_LEGACY_CONFIG', 'legacy VLESS inbound must contain exactly one user');
  }
  const user = requireObject(inbound.users[0], 'legacy VLESS user');
  const tls = requireObject(inbound.tls, 'legacy TLS configuration');
  const reality = requireObject(tls.reality, 'legacy REALITY configuration');
  if (!Array.isArray(reality.short_id) || reality.short_id.length !== 1) {
    throw new MigrationError('INVALID_LEGACY_CONFIG', 'legacy REALITY short id is invalid');
  }
  const listenPort = Number(inbound.listen_port);
  return {
    uuid: legacyString(user.uuid, 'legacy UUID'),
    listenPort: validatePort(listenPort, 'legacy.listenPort'),
    serverName: legacyString(tls.server_name ?? reality.handshake?.server, 'legacy server name'),
    privateKey: legacyString(reality.private_key, 'legacy REALITY private key'),
    shortId: legacyString(reality.short_id[0], 'legacy REALITY short id'),
    authKey: legacyString(endpoint.auth_key, 'legacy Tailscale auth key', { optional: true }),
    exitNode: legacyString(endpoint.exit_node, 'legacy exit node'),
    hostname: legacyString(endpoint.hostname, 'legacy Tailscale hostname'),
    stateDirectory: legacyString(endpoint.state_directory, 'legacy Tailscale state directory'),
  };
}

function consistent(name, ...candidates) {
  const values = candidates.filter((value) => value !== undefined && value !== null && value !== '');
  if (values.length === 0) throw new MigrationError('INCOMPLETE_LEGACY_STATE', `${name} is missing`);
  if (values.some((value) => String(value) !== String(values[0]))) {
    throw new MigrationError('CONFLICTING_LEGACY_STATE', `${name} conflicts between legacy sources`);
  }
  return values[0];
}

function optionalPort(raw, name, fallback) {
  if (raw === undefined || raw === null || raw === '') return validatePort(fallback, name);
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,4}$/u.test(raw)) {
    throw new ValidationError(name, 'must be a decimal TCP port');
  }
  return validatePort(Number(raw), name);
}

function migrationTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  return validateTimestamp(value instanceof Date ? value.toISOString() : value, 'now');
}

function dummyAdminRecord() {
  return {
    algorithm: 'scrypt',
    salt: Buffer.alloc(16, 1).toString('base64url'),
    hash: Buffer.alloc(32, 2).toString('base64url'),
    keyLength: 32,
    cost: 16384,
    blockSize: 8,
    parallelization: 1,
  };
}

export function buildMigratedState({
  legacyEnvironment,
  legacyConfig,
  fallbackEnvironment = {},
  apiKey = null,
  adminRecord = dummyAdminRecord(),
  randomBytesImpl = randomBytes,
  now = () => new Date(),
}) {
  const timestamp = migrationTimestamp(now);
  const uuid = consistent('UUID', legacyEnvironment.UUID, legacyConfig.uuid);
  const serverName = consistent('SERVER_NAME', legacyEnvironment.SERVER_NAME, legacyConfig.serverName);
  const privateKey = consistent(
    'REALITY_PRIVATE_KEY',
    legacyEnvironment.REALITY_PRIVATE_KEY,
    legacyConfig.privateKey,
  );
  const shortId = consistent('SHORT_ID', legacyEnvironment.SHORT_ID, legacyConfig.shortId);
  const rawToken = consistent('SUB_TOKEN', legacyEnvironment.SUB_TOKEN);
  const publicKey = consistent('REALITY_PUBLIC_KEY', legacyEnvironment.REALITY_PUBLIC_KEY);
  const publicHost = consistent('VPS_HOST', legacyEnvironment.VPS_HOST || fallbackEnvironment.VPS_HOST);
  const displayName = legacyEnvironment.NODE_NAME || fallbackEnvironment.INITIAL_USER_NAME || 'Legacy Primary';
  const state = validateState({
    schemaVersion: 2,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    gateway: {
      host: classifyHost(publicHost, 'VPS_HOST'),
      advertisedPort: optionalPort(
        legacyEnvironment.NODE_PORT ?? fallbackEnvironment.ADVERTISED_PORT ?? fallbackEnvironment.VPN_PORT,
        'ADVERTISED_PORT',
        443,
      ),
      listenPort: optionalPort(
        fallbackEnvironment.LISTEN_PORT ?? fallbackEnvironment.NODE_PORT,
        'LISTEN_PORT',
        legacyConfig.listenPort,
      ),
      publicBaseUrl: legacyEnvironment.PUBLIC_BASE_URL
        || legacyEnvironment.PUBLIC_ORIGIN
        || fallbackEnvironment.PUBLIC_BASE_URL
        || null,
    },
    reality: {
      serverName,
      privateKey,
      publicKey,
      shortId,
    },
    tailscale: {
      hostname: legacyConfig.hostname
        || legacyEnvironment.TS_HOSTNAME
        || fallbackEnvironment.TS_HOSTNAME
        || 'vps-reality',
      stateDirectory: validateAbsoluteStatePath(
        fallbackEnvironment.MIGRATION_STATE_DIR
          || legacyConfig.stateDirectory
          || legacyEnvironment.SINGBOX_STATE_DIR
          || fallbackEnvironment.SINGBOX_STATE_DIR,
        'SINGBOX_STATE_DIR',
      ),
      authKey: legacyConfig.authKey || legacyEnvironment.TS_AUTH_KEY || null,
      apiKey: (apiKey ?? legacyEnvironment.TS_API_KEY) || null,
      exitNode: legacyConfig.exitNode || legacyEnvironment.EXIT_NODE,
    },
    health: {
      listenPort: optionalPort(fallbackEnvironment.HEALTH_PORT, 'HEALTH_PORT', 19080),
      ...generateHealthCredentials(randomBytesImpl),
      target: {
        // Keep readiness coupled to the routed REALITY origin. Allowing an
        // arbitrary IP here would fail to prove that exit-routed DNS works.
        host: serverName,
        port: 443,
      },
    },
    admin: { scrypt: adminRecord },
    users: [{
      id: 'legacy-primary',
      displayName: normalizeDisplayName(displayName, 'legacy.NODE_NAME'),
      uuid,
      tokenHash: hashSubscriptionToken(rawToken),
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      disabledAt: null,
      revokedAt: null,
    }],
  });
  return { state, rawToken };
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
      gatewayHost: preview.gateway.host,
      advertisedPort: preview.gateway.advertisedPort,
      listenPort: preview.gateway.listenPort,
      serverName: preview.reality.serverName,
      tailscaleHostname: preview.tailscale.hostname,
      tailscaleStateDirectory: preview.tailscale.stateDirectory,
      exitNode: preview.tailscale.exitNode,
      userId: preview.users[0].id,
      displayName: preview.users[0].displayName,
    }),
  };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createLegacyBackup({ dataDir, inspection, timestamp, randomBytesImpl }) {
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

export async function migrateLegacyV1({
  apply = false,
  dataDir,
  envPath,
  configPath,
  env = {},
  repository = null,
  singBoxPath = '/usr/local/bin/sing-box',
  execFileImpl,
  validateConfigImpl,
  randomBytesImpl = randomBytes,
  now = () => new Date(),
} = {}) {
  const normalizedDataDir = validateAbsoluteStatePath(dataDir, 'DATA_DIR');
  const repo = repository ?? new RevisionRepository(normalizedDataDir);
  if (apply) {
    const existing = await repo.readCurrent();
    if (existing !== null) {
      return Object.freeze({ status: 'existing', id: existing.id, revision: existing.state.revision });
    }
  } else if (await pathExists(path.join(normalizedDataDir, 'current'))) {
    const existing = await repo.readCurrent();
    if (existing !== null) {
      return Object.freeze({ status: 'existing', id: existing.id, revision: existing.state.revision });
    }
  }

  let apiKey = null;
  if (env.TS_API_KEY_FILE) {
    apiKey = await readSecretFile(env.TS_API_KEY_FILE, { description: 'Tailscale API-key file' });
  }
  const inspection = await inspectLegacyV1({
    envPath,
    configPath,
    fallbackEnvironment: env,
  });
  if (!apply) {
    return Object.freeze({
      status: 'dry-run',
      sourcePaths: Object.freeze([envPath, configPath]),
      summary: inspection.summary,
    });
  }

  const timestamp = migrationTimestamp(now);
  const preparedAdmin = await prepareAdminSecret(normalizedDataDir, { randomBytesImpl });
  const adminRecord = await createAdminScryptRecord(preparedAdmin.secret, { randomBytesImpl });
  const { state } = buildMigratedState({
    legacyEnvironment: inspection.legacyEnvironment,
    legacyConfig: inspection.legacyConfig,
    fallbackEnvironment: env,
    apiKey,
    adminRecord,
    randomBytesImpl,
    now: timestamp,
  });
  await validateCandidateConfig(state, {
    dataDir: normalizedDataDir,
    singBoxPath,
    execFileImpl,
    validateConfigImpl,
  });
  const backupPath = await createLegacyBackup({
    dataDir: normalizedDataDir,
    inspection,
    timestamp,
    randomBytesImpl,
  });
  await persistPreparedAdminSecret(preparedAdmin);
  const revision = await repo.initialize(state, { operation: 'migrate-v1' });
  return Object.freeze({
    status: 'migrated',
    id: revision.id,
    revision: revision.revision,
    backupPath,
    adminSecretPath: preparedAdmin.secretPath,
  });
}
