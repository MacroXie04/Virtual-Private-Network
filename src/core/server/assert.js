import { isDeepStrictEqual } from 'node:util';
import { MAX_EXTRA_EXITS, validateExitAddress, validateExitProfileId } from '../identity/exit-profiles.js';
import { HEALTH_PASSWORD_BYTES, HEALTH_USERNAME, MAX_USERS, VLESS_LISTEN_PORT } from '../model/policy.js';
import { validateState } from '../model/state.js';
import {
  ValidationError,
  isPlainObject,
  validateAbsoluteStatePath,
  validatePort,
  validateUuid,
} from '../validation/values.js';
import { classifyHost } from '../validation/hosts.js';
import { renderServerConfig } from './model.js';
import { assertSingleExitConfig } from './single-exit.js';

function fail(path, message) {
  throw new ValidationError(path, message);
}

function assertMultipleExitConfig(value, expectedState) {
  if (!isPlainObject(value)) fail('config', 'must be an object');
  if (Object.hasOwn(value, 'outbounds')) fail('config.outbounds', 'must not provide a fallback outbound');
  if (!Array.isArray(value.endpoints)
    || value.endpoints.length < 2 || value.endpoints.length > MAX_EXTRA_EXITS + 1) {
    fail('config.endpoints', 'must contain the default endpoint and at most 15 extra exits');
  }
  const defaultEndpoint = value.endpoints[0];
  if (!isPlainObject(defaultEndpoint)) fail('config.endpoints[0]', 'must be a Tailscale endpoint');
  const normalizedHost = classifyHost(defaultEndpoint.hostname, 'config.endpoints[0].hostname');
  if (normalizedHost.kind !== 'dns') fail('config.endpoints[0].hostname', 'must be a DNS name');
  const stateDirectory = validateAbsoluteStatePath(
    defaultEndpoint.state_directory, 'config.endpoints[0].state_directory',
  );
  const secret = (endpoint, path) => {
    if (!Object.hasOwn(endpoint, 'auth_key')) return null;
    if (typeof endpoint.auth_key !== 'string'
      || endpoint.auth_key.length < 8 || endpoint.auth_key.length > 512
      || endpoint.auth_key !== endpoint.auth_key.trim()
      || /[\u0000-\u001f\u007f-\u009f]/u.test(endpoint.auth_key)) {
      fail(path, 'must contain a valid bootstrap credential');
    }
    return endpoint.auth_key;
  };
  const ids = new Set();
  const addresses = new Set();
  const extraExits = value.endpoints.slice(1).map((endpoint, index) => {
    const path = `config.endpoints[${index + 1}]`;
    if (!isPlainObject(endpoint) || typeof endpoint.tag !== 'string' || !endpoint.tag.startsWith('ts-')) {
      fail(path, 'must be a named Tailscale exit endpoint');
    }
    const id = validateExitProfileId(endpoint.tag.slice(3), `${path}.tag`);
    const address = validateExitAddress(endpoint.exit_node, `${path}.exit_node`);
    if (ids.has(id) || addresses.has(address)) fail(path, 'must identify a unique exit');
    ids.add(id);
    addresses.add(address);
    return { id, name: `exit-${id}`, address, authKey: secret(endpoint, `${path}.auth_key`) };
  });
  if (!Array.isArray(value.inbounds) || value.inbounds.length !== 2) {
    fail('config.inbounds', 'must contain the public and health inbounds');
  }
  const [publicInbound, healthInbound] = value.inbounds;
  if (!isPlainObject(publicInbound) || !Array.isArray(publicInbound.users)
    || publicInbound.users.length % value.endpoints.length !== 0) {
    fail('config.inbounds.vless-in.users', 'must contain one credential per user and exit');
  }
  const userCount = publicInbound.users.length / value.endpoints.length;
  if (userCount > MAX_USERS) fail('config.inbounds.vless-in.users', 'contains too many active users');
  if (new Set(publicInbound.users.map((user) => user?.uuid)).size !== publicInbound.users.length
    || new Set(publicInbound.users.map((user) => user?.name)).size !== publicInbound.users.length) {
    fail('config.inbounds.vless-in.users', 'must contain unique credentials across every exit');
  }
  const names = new Set();
  const uuids = new Set();
  const users = publicInbound.users.slice(0, userCount).map((user, index) => {
    const path = `config.inbounds.vless-in.users[${index}]`;
    if (!isPlainObject(user) || typeof user.name !== 'string'
      || user.name.length < 3 || user.name.length > 64
      || !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(user.name)) {
      fail(path, 'must identify a canonical active user');
    }
    const uuid = validateUuid(user.uuid, `${path}.uuid`);
    if (names.has(user.name) || uuids.has(uuid)) fail(path, 'must contain unique credentials');
    names.add(user.name);
    uuids.add(uuid);
    return { id: user.name, uuid, status: 'active' };
  });
  if (!isPlainObject(healthInbound) || !Array.isArray(healthInbound.users)
    || healthInbound.users.length !== value.endpoints.length) {
    fail('config.inbounds.health-in.users', 'must contain one health credential per exit');
  }
  const baseHealth = healthInbound.users[0];
  const decoded = typeof baseHealth?.password === 'string'
    ? Buffer.from(baseHealth.password, 'base64url') : null;
  if (baseHealth?.username !== HEALTH_USERNAME || decoded?.length !== HEALTH_PASSWORD_BYTES
    || decoded.toString('base64url') !== baseHealth.password) {
    fail('config.inbounds.health-in.users[0]', 'must contain valid SOCKS credentials');
  }
  const listenPort = validatePort(healthInbound.listen_port, 'config.inbounds.health-in.listen_port');
  if (listenPort === VLESS_LISTEN_PORT) fail('config.inbounds', 'listen ports must differ');
  if (!isPlainObject(publicInbound.transport)
    || typeof publicInbound.transport.path !== 'string'
    || !/^\/[A-Za-z0-9_-]{43,128}$/u.test(publicInbound.transport.path)) {
    fail('config.inbounds.vless-in.transport', 'must use the canonical WebSocket path');
  }
  const inferredState = {
    tailscale: {
      hostname: normalizedHost.value,
      stateDirectory,
      exitNode: classifyHost(defaultEndpoint.exit_node, 'config.endpoints[0].exit_node').value,
      authKey: secret(defaultEndpoint, 'config.endpoints[0].auth_key'),
      extraExits,
    },
    gateway: { websocketPath: publicInbound.transport.path },
    health: { listenPort, username: HEALTH_USERNAME, password: baseHealth.password },
    users,
  };
  // Reconstruct all mappings from the base credentials, including the DNS cache
  // boundary, private-address rejections, and the final unknown-traffic reject.
  const expected = renderServerConfig(expectedState ?? inferredState);
  if (!isDeepStrictEqual(value, expected)) {
    fail('config', 'does not match the fail-closed exit mappings and selected state');
  }
  return value;
}

export function assertFailClosedConfig(value, expectedState = null) {
  const state = expectedState === null ? null : validateState(expectedState);
  if ((state?.tailscale.extraExits?.length ?? 0) > 0 || (value?.endpoints?.length ?? 0) > 1) {
    return assertMultipleExitConfig(value, state);
  }
  return assertSingleExitConfig(value, state);
}
