import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  generateHealthCredentials,
  generateWebSocketPath,
  prepareAdminSecret,
  persistPreparedAdminSecret,
  readBoundedFileNoFollow,
  readSecretFile,
  validateCandidateConfig,
  writePrivateFileExclusive,
} from '../state/bootstrap.js';
import {
  createAdminScryptRecord,
  hashSubscriptionToken,
} from '../core/credentials.js';
import {
  validateLegacyRealityKeyPair,
  validateLegacyRealityShortId,
} from './legacy-reality.js';
import { RevisionRepository } from '../state/repository.js';
import { STATE_SCHEMA_VERSION, validateState } from '../core/state-schema.js';
import {
  ValidationError,
  classifyHost,
  isPlainObject,
  normalizeDisplayName,
  validateAbsoluteStatePath,
  validatePort,
  validatePublicDnsHostname,
  validateTimestamp,
  validateWebSocketPath,
} from '../core/validation.js';

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
  validateLegacyRealityKeyPair(privateKey, publicKey, {
    privatePath: 'legacy.REALITY_PRIVATE_KEY',
    publicPath: 'legacy.REALITY_PUBLIC_KEY',
  });
  validateLegacyRealityShortId(shortId, 'legacy.SHORT_ID');
  const legacyOrigin = classifyHost(serverName, 'legacy.SERVER_NAME');
  if (legacyOrigin.kind !== 'dns') {
    throw new MigrationError('INVALID_LEGACY_CONFIG', 'legacy SERVER_NAME must be a DNS hostname');
  }
  const websocketPath = fallbackEnvironment.WS_PATH
    ? validateWebSocketPath(fallbackEnvironment.WS_PATH, 'WS_PATH')
    : generateWebSocketPath(randomBytesImpl);
  const displayName = legacyEnvironment.NODE_NAME || fallbackEnvironment.INITIAL_USER_NAME || 'Legacy Primary';
  const state = validateState({
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    gateway: {
      vpnPublicHostname: validatePublicDnsHostname(
        consistent('VPN_PUBLIC_HOSTNAME', fallbackEnvironment.VPN_PUBLIC_HOSTNAME),
        'VPN_PUBLIC_HOSTNAME',
      ),
      subscriptionPublicBaseUrl: consistent(
        'SUBSCRIPTION_PUBLIC_BASE_URL',
        fallbackEnvironment.SUBSCRIPTION_PUBLIC_BASE_URL,
      ),
      adminPublicHostname: validatePublicDnsHostname(
        consistent('ADMIN_PUBLIC_HOSTNAME', fallbackEnvironment.ADMIN_PUBLIC_HOSTNAME),
        'ADMIN_PUBLIC_HOSTNAME',
      ),
      websocketPath,
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
        host: validatePublicDnsHostname(
          consistent('EGRESS_HEALTH_HOST', fallbackEnvironment.EGRESS_HEALTH_HOST),
          'EGRESS_HEALTH_HOST',
        ),
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

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const MIGRATION_REVISION_ID = /^[0-9]{16}-[0-9a-f]{16}$/u;
const MIGRATION_DIGEST = /^[0-9a-f]{64}$/u;

function migrationLineageError(message) {
  return new MigrationError('INVALID_MIGRATION_LINEAGE', message);
}

function migrationInvariantDigest(state) {
  return digest(Buffer.from(JSON.stringify({
    schemaVersion: state.schemaVersion,
    createdAt: state.createdAt,
    gateway: state.gateway,
    tailscale: {
      hostname: state.tailscale.hostname,
      stateDirectory: state.tailscale.stateDirectory,
      exitNode: state.tailscale.exitNode,
    },
    health: state.health,
    admin: state.admin,
    users: state.users,
  }), 'utf8'));
}

function initialStateBytes(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function migrationLineageRecord(state) {
  const bytes = initialStateBytes(state);
  return {
    schemaVersion: 1,
    source: 'legacy-v1',
    initialRevisionId: `${String(state.revision).padStart(16, '0')}-${digest(bytes).slice(0, 16)}`,
    initialRevision: 1,
    initialStateSha256: digest(bytes),
    invariantSha256: migrationInvariantDigest(state),
  };
}

function parseMigrationLineage(bytes) {
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw migrationLineageError('legacy migration lineage record is not valid JSON');
  }
  const keys = [
    'schemaVersion',
    'source',
    'initialRevisionId',
    'initialRevision',
    'initialStateSha256',
    'invariantSha256',
  ];
  if (!isPlainObject(record)
      || Object.keys(record).length !== keys.length
      || !keys.every((key) => Object.hasOwn(record, key))
      || record.schemaVersion !== 1
      || record.source !== 'legacy-v1'
      || record.initialRevision !== 1
      || !MIGRATION_REVISION_ID.test(record.initialRevisionId)
      || !MIGRATION_DIGEST.test(record.initialStateSha256)
      || !MIGRATION_DIGEST.test(record.invariantSha256)) {
    throw migrationLineageError('legacy migration lineage record is invalid');
  }
  return record;
}

function assertMigrationLineageMatches(lineage, expected) {
  if (!isDeepStrictEqual(lineage, expected)) {
    throw migrationLineageError('legacy migration lineage does not match the reviewed initial revision');
  }
}

async function resolveMigrationApiKey(env, inspection) {
  if (env.TS_API_KEY_FILE) {
    return readSecretFile(env.TS_API_KEY_FILE, { description: 'Tailscale API-key file' });
  }
  return inspection.legacyEnvironment.TS_API_KEY || null;
}

function reconstructLegacyInitialState({
  inspection,
  fallbackEnvironment,
  expectedStateDirectory,
  candidateState,
  apiKey,
}) {
  const healthPassword = Buffer.from(candidateState.health.password, 'base64url');
  return buildMigratedState({
    legacyEnvironment: inspection.legacyEnvironment,
    legacyConfig: inspection.legacyConfig,
    fallbackEnvironment: {
      ...fallbackEnvironment,
      MIGRATION_STATE_DIR: expectedStateDirectory,
    },
    apiKey,
    adminRecord: candidateState.admin.scrypt,
    randomBytesImpl: (size) => {
      if (size !== healthPassword.length) {
        throw migrationLineageError('legacy migration health credentials are inconsistent');
      }
      return healthPassword;
    },
    now: candidateState.createdAt,
  }).state;
}

function expectedCredentialScrubState(expectedInitial, updatedAt) {
  return validateState({
    ...expectedInitial,
    revision: 2,
    updatedAt,
    tailscale: {
      ...expectedInitial.tailscale,
      authKey: null,
      apiKey: null,
    },
  });
}

/**
 * Authenticate the only repository states that may resume the outer v1
 * migration transaction. The controller legitimately replaces revision 1
 * with a credential-free revision 2 before the installer commits its marker,
 * so the operation label alone is neither sufficient nor stable. Bind all
 * invariant state to a private record before services start, then recognize
 * only the exact initial state or its single credentials.scrub successor.
 */
export async function assertLegacyV1MigrationLineage({
  dataDir,
  envPath,
  configPath,
  fallbackEnvironment = {},
  expectedStateDirectory,
  lineagePath,
  statePublished = false,
  repository = null,
} = {}) {
  const normalizedDataDir = validateAbsoluteStatePath(dataDir, 'DATA_DIR');
  const normalizedStateDirectory = validateAbsoluteStatePath(
    expectedStateDirectory,
    'EXPECTED_STATE_DIRECTORY',
  );
  const normalizedLineagePath = validateAbsoluteStatePath(lineagePath, 'MIGRATION_LINEAGE_FILE');
  if (typeof statePublished !== 'boolean') {
    throw new TypeError('statePublished must be a boolean');
  }
  const repo = repository ?? new RevisionRepository(normalizedDataDir);
  const [current, runtime] = await Promise.all([
    repo.readCurrent(),
    repo.readRuntime(),
  ]);
  if (!current || !runtime || current.id !== runtime.id) {
    throw migrationLineageError('legacy migration pointers do not identify one authoritative revision');
  }

  const inspection = await inspectLegacyV1({
    envPath,
    configPath,
    fallbackEnvironment: {
      ...fallbackEnvironment,
      MIGRATION_STATE_DIR: normalizedStateDirectory,
    },
  });
  const apiKey = await resolveMigrationApiKey(fallbackEnvironment, inspection);
  const expectedInitial = reconstructLegacyInitialState({
    inspection,
    fallbackEnvironment: {
      ...fallbackEnvironment,
      MIGRATION_STATE_DIR: normalizedStateDirectory,
    },
    expectedStateDirectory: normalizedStateDirectory,
    candidateState: current.state,
    apiKey,
  });
  const expectedLineage = migrationLineageRecord(expectedInitial);
  let status;
  if (current.manifest.operation === 'migrate-v1') {
    if (current.id !== expectedLineage.initialRevisionId
        || current.state.revision !== 1
        || !isDeepStrictEqual(current.state, expectedInitial)) {
      throw migrationLineageError('current migrate-v1 revision does not match the reviewed legacy sources');
    }
    status = 'migrate-v1';
  } else if (current.manifest.operation === 'credentials.scrub') {
    if (!statePublished) {
      throw migrationLineageError('credential scrub appeared before the migration state was published');
    }
    if (expectedInitial.tailscale.authKey === null && expectedInitial.tailscale.apiKey === null) {
      throw migrationLineageError('credential scrub has no credential-bearing migration predecessor');
    }
    const expectedScrub = expectedCredentialScrubState(expectedInitial, current.state.updatedAt);
    if (current.state.revision !== 2 || !isDeepStrictEqual(current.state, expectedScrub)) {
      throw migrationLineageError('current credential scrub is not the exact successor of the legacy migration');
    }
    status = 'credentials.scrub';
  } else {
    throw migrationLineageError('current revision is not part of the allowed legacy migration lineage');
  }

  let lineage;
  let publishLineage = false;
  if (await pathExists(normalizedLineagePath)) {
    lineage = parseMigrationLineage(await readBoundedFileNoFollow(normalizedLineagePath, {
      maxBytes: 1024,
      requirePrivate: true,
      description: 'legacy migration lineage record',
    }));
    assertMigrationLineageMatches(lineage, expectedLineage);
  } else {
    if (status !== 'migrate-v1' || statePublished) {
      throw migrationLineageError('legacy migration lineage record is missing');
    }
    lineage = expectedLineage;
    publishLineage = true;
  }

  const revisions = await repo.listRevisions();
  const others = revisions.filter((revision) => revision.id !== current.id);
  if (status === 'migrate-v1' && others.length > 0) {
    if (!statePublished || others.length !== 1) {
      throw migrationLineageError('legacy migration repository contains an unrelated revision');
    }
    if (expectedInitial.tailscale.authKey === null && expectedInitial.tailscale.apiKey === null) {
      throw migrationLineageError('interrupted credential scrub has no credential-bearing predecessor');
    }
    const interruptedScrub = await repo.readRevision(others[0].id);
    const expectedScrub = expectedCredentialScrubState(
      expectedInitial,
      interruptedScrub.state.updatedAt,
    );
    if (interruptedScrub.manifest.operation !== 'credentials.scrub'
        || interruptedScrub.state.revision !== 2
        || !isDeepStrictEqual(interruptedScrub.state, expectedScrub)) {
      throw migrationLineageError('interrupted credential scrub is not an exact migration successor');
    }
    const removed = await repo.removeRevision(interruptedScrub.id);
    if (!removed) {
      throw migrationLineageError('interrupted credential scrub could not be retired safely');
    }
  } else if (status === 'credentials.scrub') {
    for (const revision of others) {
      if (revision.id !== lineage.initialRevisionId) {
        throw migrationLineageError('legacy migration repository contains an unrelated revision');
      }
      const predecessor = await repo.readRevision(revision.id);
      if (predecessor.manifest.operation !== 'migrate-v1'
          || !isDeepStrictEqual(predecessor.state, expectedInitial)) {
        throw migrationLineageError('credential scrub predecessor is not the published migrate-v1 revision');
      }
    }
  }
  if (publishLineage) {
    await writePrivateFileExclusive(
      normalizedLineagePath,
      Buffer.from(`${JSON.stringify(lineage, null, 2)}\n`, 'utf8'),
    );
  }

  return Object.freeze({
    status,
    id: current.id,
    revision: current.state.revision,
    initialRevisionId: lineage.initialRevisionId,
  });
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

async function readPrivateMigrationMarker(markerPath, description, maxBytes) {
  const stat = await lstat(markerPath).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (stat === null
      || stat.isSymbolicLink()
      || !stat.isFile()
      || stat.nlink !== 1
      || stat.uid !== (process.geteuid?.() ?? process.getuid?.() ?? 0)
      || (stat.mode & 0o777) !== 0o600) {
    throw migrationLineageError(`${description} is missing or unsafe`);
  }
  const bytes = await readBoundedFileNoFollow(markerPath, {
    maxBytes,
    requirePrivate: true,
    description,
  });
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.includes('\r') || text.includes('\0')) {
    throw migrationLineageError(`${description} is not canonical`);
  }
  return text.slice(0, -1);
}

async function assertEmptyPrivateMigrationMarker(markerPath, description) {
  const stat = await lstat(markerPath).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (stat === null
      || stat.isSymbolicLink()
      || !stat.isFile()
      || stat.nlink !== 1
      || stat.uid !== (process.geteuid?.() ?? process.getuid?.() ?? 0)
      || (stat.mode & 0o777) !== 0o600
      || stat.size !== 0) {
    throw migrationLineageError(`${description} is missing or unsafe`);
  }
}

async function authenticateLegacyMigrationMarker({ dataDir, markerDir, inspection }) {
  if (!markerDir) return null;
  const normalizedMarkerDir = validateAbsoluteStatePath(markerDir, 'MIGRATION_MARKER_DIR');
  if (normalizedMarkerDir !== path.join(dataDir, '.legacy-migration-in-progress')) {
    throw migrationLineageError('legacy migration marker path is not canonical');
  }
  const markerStat = await lstat(normalizedMarkerDir).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (markerStat === null
      || markerStat.isSymbolicLink()
      || !markerStat.isDirectory()
      || markerStat.uid !== (process.geteuid?.() ?? process.getuid?.() ?? 0)
      || (markerStat.mode & 0o777) !== 0o700) {
    throw migrationLineageError('legacy migration marker directory is missing or unsafe');
  }
  const [envDigest, configDigest, sourceState] = await Promise.all([
    readPrivateMigrationMarker(path.join(normalizedMarkerDir, 'env.sha256'), 'legacy environment digest', 65),
    readPrivateMigrationMarker(path.join(normalizedMarkerDir, 'config.sha256'), 'legacy config digest', 65),
    readPrivateMigrationMarker(path.join(normalizedMarkerDir, 'source-state'), 'legacy state source marker', 4096),
  ]);
  if (!MIGRATION_DIGEST.test(envDigest) || envDigest !== digest(inspection.environmentBytes)) {
    throw migrationLineageError('legacy environment does not match the approved migration marker');
  }
  if (!MIGRATION_DIGEST.test(configDigest) || configDigest !== digest(inspection.configBytes)) {
    throw migrationLineageError('legacy configuration does not match the approved migration marker');
  }
  if (sourceState !== validateAbsoluteStatePath(
    inspection.legacyConfig.stateDirectory,
    'legacy.stateDirectory',
  )) {
    throw migrationLineageError('legacy Tailscale state does not match the approved migration marker');
  }
  await assertEmptyPrivateMigrationMarker(
    path.join(normalizedMarkerDir, 'state-copied'),
    'legacy state-copied marker',
  );
  const statePublishedPath = path.join(normalizedMarkerDir, 'state-published');
  const statePublished = await pathExists(statePublishedPath);
  if (statePublished) {
    await assertEmptyPrivateMigrationMarker(statePublishedPath, 'legacy state-published marker');
  }
  if (await pathExists(path.join(normalizedMarkerDir, 'committed'))) {
    throw migrationLineageError('legacy migration marker is already committed');
  }
  return Object.freeze({
    directory: normalizedMarkerDir,
    lineagePath: path.join(normalizedMarkerDir, 'lineage.json'),
    statePublished,
  });
}

async function readMigrationLineage(lineagePath) {
  return parseMigrationLineage(await readBoundedFileNoFollow(lineagePath, {
    maxBytes: 1024,
    requirePrivate: true,
    description: 'legacy migration lineage record',
  }));
}

async function recoverLegacyMigrationOrphan({
  repository,
  revisions,
  marker,
  inspection,
  env,
  apiKey,
  stateDirectory,
  dataDir,
  singBoxPath,
  execFileImpl,
  validateConfigImpl,
}) {
  if (revisions.length === 0) return null;
  if (marker === null) {
    throw new MigrationError(
      'ORPHANED_REVISION',
      'an unpointed revision cannot be recovered without the approved legacy migration marker',
    );
  }
  if (marker.statePublished || revisions.length !== 1 || !(await pathExists(marker.lineagePath))) {
    throw migrationLineageError('legacy migration orphan set is not an authorized pre-publication state');
  }
  const lineage = await readMigrationLineage(marker.lineagePath);
  const orphan = await repository.readRevision(revisions[0].id);
  const expectedInitial = reconstructLegacyInitialState({
    inspection,
    fallbackEnvironment: env,
    expectedStateDirectory: stateDirectory,
    candidateState: orphan.state,
    apiKey,
  });
  const expectedLineage = migrationLineageRecord(expectedInitial);
  assertMigrationLineageMatches(lineage, expectedLineage);
  if (orphan.id !== expectedLineage.initialRevisionId
      || orphan.manifest.operation !== 'migrate-v1'
      || orphan.state.revision !== 1
      || !isDeepStrictEqual(orphan.state, expectedInitial)) {
    throw migrationLineageError('unpointed revision is not the exact approved migrate-v1 candidate');
  }
  await validateCandidateConfig(orphan.state, {
    dataDir,
    singBoxPath,
    execFileImpl,
    validateConfigImpl,
  });
  await repository.activateRuntime(orphan.id);
  await repository.activateCurrent(orphan.id);
  return Object.freeze({
    status: 'recovered',
    id: orphan.id,
    revision: orphan.state.revision,
    adminSecretPath: path.join(dataDir, 'admin-secret'),
  });
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

  const inspection = await inspectLegacyV1({
    envPath,
    configPath,
    fallbackEnvironment: env,
  });
  const apiKey = await resolveMigrationApiKey(env, inspection);
  if (!apply) {
    return Object.freeze({
      status: 'dry-run',
      sourcePaths: Object.freeze([envPath, configPath]),
      summary: inspection.summary,
    });
  }

  const marker = await authenticateLegacyMigrationMarker({
    dataDir: normalizedDataDir,
    markerDir: env.MIGRATION_MARKER_DIR,
    inspection,
  });
  const revisions = await repo.listRevisions();
  const recovered = await recoverLegacyMigrationOrphan({
    repository: repo,
    revisions,
    marker,
    inspection,
    env,
    apiKey,
    stateDirectory: validateAbsoluteStatePath(
      env.MIGRATION_STATE_DIR
        || inspection.legacyConfig.stateDirectory
        || inspection.legacyEnvironment.SINGBOX_STATE_DIR
        || env.SINGBOX_STATE_DIR,
      'SINGBOX_STATE_DIR',
    ),
    dataDir: normalizedDataDir,
    singBoxPath,
    execFileImpl,
    validateConfigImpl,
  });
  if (recovered !== null) return recovered;
  if (marker?.statePublished) {
    throw migrationLineageError('migration state was marked published without an authoritative revision');
  }
  if (marker && await pathExists(marker.lineagePath)) {
    // A crash after publishing intent but before the immutable revision leaves
    // no authority to recover. Validate and remove only that private intent;
    // the new attempt will publish a fresh commitment before its revision.
    await readMigrationLineage(marker.lineagePath);
    await unlink(marker.lineagePath);
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
  if (marker !== null) {
    await writePrivateFileExclusive(
      marker.lineagePath,
      Buffer.from(`${JSON.stringify(migrationLineageRecord(state), null, 2)}\n`, 'utf8'),
    );
  }
  const revision = await repo.initialize(state, { operation: 'migrate-v1' });
  return Object.freeze({
    status: 'migrated',
    id: revision.id,
    revision: revision.revision,
    backupPath,
    adminSecretPath: preparedAdmin.secretPath,
  });
}
