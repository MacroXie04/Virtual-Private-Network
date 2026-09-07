import { isPlainObject, validatePort } from '../core/validation.js';
import { MigrationError } from './migration-errors.js';

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
