import { validateScryptRecord } from '../core/credentials.js';
import { validateLegacyRealityKeyPair, validateLegacyRealityShortId } from './legacy-reality.js';
import { validateState } from '../core/state-schema.js';
import {
  ValidationError,
  classifyHost,
  expectExactKeys,
  expectInteger,
  expectNullableString,
  expectString,
  normalizeDisplayName,
  validateAbsoluteStatePath,
  validateHostRecord,
  validatePort,
  validateTimestamp,
  validateTokenHash,
  validateUuid,
} from '../core/validation.js';

const HEALTH_USERNAME = 'vpn-health';

function legacyPublicBaseUrl(value, path) {
  if (value === null) return null;
  const raw = expectString(value, path, { min: 9, max: 2048 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(path, 'must be an absolute URL');
  }
  if (raw !== raw.trim() || parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443')) {
    throw new ValidationError(path, 'is not a supported legacy HTTPS URL');
  }
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  classifyHost(host, `${path}.host`);
  if (parsed.pathname.includes('//') || raw.includes('\\')) {
    throw new ValidationError(path, 'is not a supported legacy HTTPS URL');
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '');
  return `${parsed.origin}${pathname}`;
}

function legacySecret(value, path) {
  const secret = expectNullableString(value, path, { min: 8, max: 512 });
  if (secret !== null && secret !== secret.trim()) {
    throw new ValidationError(path, 'must not contain surrounding whitespace');
  }
  return secret;
}

function dnsName(value, path) {
  const host = classifyHost(value, path);
  if (host.kind !== 'dns') throw new ValidationError(path, 'must be a DNS name');
  return host.value;
}

function validateLegacyUser(value, path) {
  const user = expectExactKeys(value, [
    'id', 'displayName', 'uuid', 'tokenHash', 'status', 'createdAt', 'updatedAt',
    'disabledAt', 'revokedAt',
  ], path);
  return {
    id: expectString(user.id, `${path}.id`, { min: 3, max: 64 }),
    displayName: normalizeDisplayName(user.displayName, `${path}.displayName`),
    uuid: validateUuid(user.uuid, `${path}.uuid`),
    tokenHash: validateTokenHash(user.tokenHash, `${path}.tokenHash`),
    status: expectString(user.status, `${path}.status`, { min: 6, max: 8 }),
    createdAt: validateTimestamp(user.createdAt, `${path}.createdAt`),
    updatedAt: validateTimestamp(user.updatedAt, `${path}.updatedAt`),
    disabledAt: user.disabledAt === null ? null : validateTimestamp(user.disabledAt, `${path}.disabledAt`),
    revokedAt: user.revokedAt === null ? null : validateTimestamp(user.revokedAt, `${path}.revokedAt`),
  };
}

export function validateLegacyV2State(value) {
  const state = expectExactKeys(value, [
    'schemaVersion', 'revision', 'createdAt', 'updatedAt', 'gateway', 'reality',
    'tailscale', 'health', 'admin', 'users',
  ], 'legacyState');
  if (state.schemaVersion !== 2) throw new ValidationError('legacyState.schemaVersion', 'must be 2');
  const gateway = expectExactKeys(
    state.gateway,
    ['host', 'advertisedPort', 'listenPort', 'publicBaseUrl'],
    'legacyState.gateway',
  );
  const reality = expectExactKeys(
    state.reality,
    ['serverName', 'privateKey', 'publicKey', 'shortId'],
    'legacyState.reality',
  );
  const pair = validateLegacyRealityKeyPair(reality.privateKey, reality.publicKey, {
    privatePath: 'legacyState.reality.privateKey',
    publicPath: 'legacyState.reality.publicKey',
  });
  const tailscale = expectExactKeys(
    state.tailscale,
    ['hostname', 'stateDirectory', 'authKey', 'apiKey', 'exitNode'],
    'legacyState.tailscale',
  );
  const health = expectExactKeys(
    state.health,
    ['listenPort', 'username', 'password', 'target'],
    'legacyState.health',
  );
  const target = expectExactKeys(health.target, ['host', 'port'], 'legacyState.health.target');
  const admin = expectExactKeys(state.admin, ['scrypt'], 'legacyState.admin');
  if (!Array.isArray(state.users)) throw new ValidationError('legacyState.users', 'must be an array');

  const normalized = {
    schemaVersion: 2,
    revision: expectInteger(state.revision, 'legacyState.revision', { min: 0 }),
    createdAt: validateTimestamp(state.createdAt, 'legacyState.createdAt'),
    updatedAt: validateTimestamp(state.updatedAt, 'legacyState.updatedAt'),
    gateway: {
      host: validateHostRecord(gateway.host, 'legacyState.gateway.host'),
      advertisedPort: validatePort(gateway.advertisedPort, 'legacyState.gateway.advertisedPort'),
      listenPort: validatePort(gateway.listenPort, 'legacyState.gateway.listenPort'),
      publicBaseUrl: legacyPublicBaseUrl(gateway.publicBaseUrl, 'legacyState.gateway.publicBaseUrl'),
    },
    reality: {
      serverName: dnsName(reality.serverName, 'legacyState.reality.serverName'),
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      shortId: validateLegacyRealityShortId(reality.shortId, 'legacyState.reality.shortId'),
    },
    tailscale: {
      hostname: dnsName(tailscale.hostname, 'legacyState.tailscale.hostname'),
      stateDirectory: validateAbsoluteStatePath(
        tailscale.stateDirectory,
        'legacyState.tailscale.stateDirectory',
      ),
      authKey: legacySecret(tailscale.authKey, 'legacyState.tailscale.authKey'),
      apiKey: legacySecret(tailscale.apiKey, 'legacyState.tailscale.apiKey'),
      exitNode: classifyHost(tailscale.exitNode, 'legacyState.tailscale.exitNode').value,
    },
    health: {
      listenPort: validatePort(health.listenPort, 'legacyState.health.listenPort'),
      username: expectString(health.username, 'legacyState.health.username', {
        min: HEALTH_USERNAME.length,
        max: HEALTH_USERNAME.length,
      }),
      password: expectString(health.password, 'legacyState.health.password', { min: 43, max: 43 }),
      target: {
        host: classifyHost(target.host, 'legacyState.health.target.host').value,
        port: validatePort(target.port, 'legacyState.health.target.port'),
      },
    },
    admin: { scrypt: validateScryptRecord(admin.scrypt, 'legacyState.admin.scrypt') },
    users: state.users.map((user, index) => validateLegacyUser(user, `legacyState.users[${index}]`)),
  };
  if (normalized.health.username !== HEALTH_USERNAME
    || !/^[A-Za-z0-9_-]{43}$/u.test(normalized.health.password)
    || Buffer.from(normalized.health.password, 'base64url').length !== 32
    || normalized.health.listenPort === normalized.gateway.listenPort) {
    throw new ValidationError('legacyState.health', 'does not match a supported schema-v2 health policy');
  }

  // Reuse the active schema for all lifecycle, chronology, uniqueness, and
  // Tailscale invariants without ever interpreting legacy transport fields.
  validateState({
    schemaVersion: 3,
    revision: normalized.revision,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    gateway: {
      vpnPublicHostname: 'vpn.migration.invalid',
      subscriptionPublicBaseUrl: 'https://subscription.migration.invalid',
      adminPublicHostname: 'admin.migration.invalid',
      websocketPath: `/${'A'.repeat(43)}`,
    },
    tailscale: normalized.tailscale,
    health: {
      ...normalized.health,
      target: { host: 'health.migration.invalid', port: 443 },
    },
    admin: normalized.admin,
    users: normalized.users,
  });
  return normalized;
}
