import { validateScryptRecord } from '../identity/credentials.js';
import { MAX_EXTRA_EXITS, validateExitAddress, validateExitProfileId } from '../identity/exit-profiles.js';
import {
  ValidationError,
  expectExactKeys,
  expectNullableString,
  expectString,
  validateAbsoluteStatePath,
  validatePort,
} from '../validation/values.js';
import { classifyHost } from '../validation/hosts.js';
import { validatePublicDnsHostname, validatePublicIngressSettings } from '../validation/ingress.js';
import { HEALTH_USERNAME, HEALTH_PASSWORD_BYTES } from './policy.js';

function nullableSecret(value, path) {
  const secret = expectNullableString(value, path, { min: 8, max: 512 });
  if (secret !== null && secret !== secret.trim()) {
    throw new ValidationError(path, 'must not contain surrounding whitespace');
  }
  return secret;
}

function normalizeDnsName(value, path) {
  const host = classifyHost(value, path);
  if (host.kind !== 'dns') throw new ValidationError(path, 'must be a DNS name');
  return host.value;
}

function normalizeConnectHost(value, path) {
  return classifyHost(value, path).value;
}

export function validateGateway(value, path) {
  return validatePublicIngressSettings(value, path);
}

export function validateTailscale(value, path) {
  const tailscale = expectExactKeys(value, [
    'hostname',
    'stateDirectory',
    'authKey',
    'apiKey',
    'exitNode',
    ...(Object.hasOwn(value ?? {}, 'extraExits') ? ['extraExits'] : []),
  ], path);
  const normalized = {
    hostname: normalizeDnsName(tailscale.hostname, `${path}.hostname`),
    stateDirectory: validateAbsoluteStatePath(tailscale.stateDirectory, `${path}.stateDirectory`),
    authKey: nullableSecret(tailscale.authKey, `${path}.authKey`),
    apiKey: nullableSecret(tailscale.apiKey, `${path}.apiKey`),
    exitNode: normalizeConnectHost(tailscale.exitNode, `${path}.exitNode`),
  };
  if (Object.hasOwn(tailscale, 'extraExits')) {
    normalized.extraExits = validateExtraExits(tailscale.extraExits, `${path}.extraExits`);
  }
  return normalized;
}

export function validateExtraExits(value, path, projected = false) {
  if (!Array.isArray(value) || value.length > MAX_EXTRA_EXITS) {
    throw new ValidationError(path, `must be an array of at most ${MAX_EXTRA_EXITS} extra exits`);
  }
  const ids = new Set();
  const names = new Set();
  const addresses = new Set();
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const exit = expectExactKeys(entry, projected
      ? ['id', 'name']
      : ['id', 'name', 'address', 'authKey'], entryPath);
    const normalized = {
      id: validateExitProfileId(exit.id, `${entryPath}.id`),
      name: normalizeDnsName(exit.name, `${entryPath}.name`),
    };
    if (ids.has(normalized.id)) throw new ValidationError(`${entryPath}.id`, 'must be unique');
    if (names.has(normalized.name)) throw new ValidationError(`${entryPath}.name`, 'must be unique');
    ids.add(normalized.id);
    names.add(normalized.name);
    if (!projected) {
      normalized.address = validateExitAddress(exit.address, `${entryPath}.address`);
      normalized.authKey = nullableSecret(exit.authKey, `${entryPath}.authKey`);
      if (addresses.has(normalized.address)) {
        throw new ValidationError(`${entryPath}.address`, 'must be unique');
      }
      addresses.add(normalized.address);
    }
    return normalized;
  });
}

export function validateHealth(value, path) {
  const health = expectExactKeys(value, ['listenPort', 'username', 'password', 'target'], path);
  const target = expectExactKeys(health.target, ['host', 'port'], `${path}.target`);
  const username = expectString(health.username, `${path}.username`, {
    min: HEALTH_USERNAME.length,
    max: HEALTH_USERNAME.length,
  });
  if (username !== HEALTH_USERNAME) {
    throw new ValidationError(`${path}.username`, `must be ${HEALTH_USERNAME}`);
  }
  const password = expectString(health.password, `${path}.password`, { min: 43, max: 43 });
  if (!/^[A-Za-z0-9_-]{43}$/u.test(password)) {
    throw new ValidationError(`${path}.password`, 'must be a canonical 256-bit base64url secret');
  }
  const decodedPassword = Buffer.from(password, 'base64url');
  if (
    decodedPassword.length !== HEALTH_PASSWORD_BYTES
    || decodedPassword.toString('base64url') !== password
  ) {
    throw new ValidationError(`${path}.password`, 'must be a canonical 256-bit base64url secret');
  }
  return {
    listenPort: validatePort(health.listenPort, `${path}.listenPort`),
    username,
    password,
    target: {
      host: validatePublicDnsHostname(target.host, `${path}.target.host`),
      port: validatePort(target.port, `${path}.target.port`),
    },
  };
}

export function validateAdmin(value, path) {
  const admin = expectExactKeys(value, ['scrypt'], path);
  return { scrypt: validateScryptRecord(admin.scrypt, `${path}.scrypt`) };
}
