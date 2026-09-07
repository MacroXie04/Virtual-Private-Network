import { randomBytes } from 'node:crypto';
import {
  generateHealthCredentials,
  generateWebSocketPath,
} from '../state/bootstrap-credentials.js';
import { hashSubscriptionToken } from '../core/credentials.js';
import { validateLegacyRealityKeyPair, validateLegacyRealityShortId } from './legacy-reality.js';
import { STATE_SCHEMA_VERSION, validateState } from '../core/state-schema.js';
import {
  ValidationError,
  classifyHost,
  normalizeDisplayName,
  validateAbsoluteStatePath,
  validatePort,
  validatePublicDnsHostname,
  validateTimestamp,
  validateWebSocketPath,
} from '../core/validation.js';
import { MigrationError } from './migration-errors.js';

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

export function migrationTimestamp(now) {
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
