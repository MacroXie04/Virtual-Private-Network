import { HEALTH_PASSWORD_BYTES, HEALTH_USERNAME, VLESS_LISTEN_HOST, VLESS_LISTEN_PORT } from '../model/policy.js';
import { ValidationError, isPlainObject } from '../validation/values.js';
import {
  TAILSCALE_ENDPOINT_TAG,
  PUBLIC_INBOUND_TAG,
  HEALTH_INBOUND_TAG,
  BOOTSTRAP_DNS_TAG,
  EXIT_DNS_TAG,
  EXIT_DNS_SERVER,
  BLOCKED_NON_INTERNET_CIDRS,
} from './model.js';
import { assertSingleExitState } from './single-exit-state.js';

function sameArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function fail(path, message) {
  throw new ValidationError(path, message);
}

function requireExactKeys(value, keys, path) {
  if (!isPlainObject(value)
    || Object.keys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))) {
    fail(path, 'contains unsupported or missing fields');
  }
}

export function assertSingleExitConfig(value, expectedState = null) {
  if (!isPlainObject(value)) fail('config', 'must be an object');
  if (Object.hasOwn(value, 'outbounds')) {
    fail('config.outbounds', 'must not provide a fallback outbound');
  }
  requireExactKeys(value, ['log', 'dns', 'inbounds', 'endpoints', 'route'], 'config');
  requireExactKeys(value.log, ['level', 'timestamp'], 'config.log');
  if (value.log.level !== 'info' || value.log.timestamp !== true) {
    fail('config.log', 'must use the auditable default logging settings');
  }
  requireExactKeys(value.route, ['rules', 'final', 'default_domain_resolver'], 'config.route');
  if (!isPlainObject(value.route)
    || value.route.final !== TAILSCALE_ENDPOINT_TAG
    || value.route.default_domain_resolver !== EXIT_DNS_TAG) {
    fail('config.route', `must route traffic through ${TAILSCALE_ENDPOINT_TAG} and domains through ${EXIT_DNS_TAG}`);
  }
  if (!Array.isArray(value.route.rules) || value.route.rules.length !== 3) {
    fail('config.route.rules', 'must resolve inbound domains and reject private/Tailnet destinations');
  }
  const routedInbounds = [PUBLIC_INBOUND_TAG, HEALTH_INBOUND_TAG];
  const [resolveRule, privateRule, tailnetRule] = value.route.rules;
  requireExactKeys(resolveRule, ['inbound', 'action', 'server'], 'config.route.rules[0]');
  requireExactKeys(privateRule, ['inbound', 'ip_is_private', 'action'], 'config.route.rules[1]');
  requireExactKeys(tailnetRule, ['inbound', 'ip_cidr', 'action'], 'config.route.rules[2]');
  if (!sameArray(resolveRule.inbound, routedInbounds)
    || resolveRule.action !== 'resolve'
    || resolveRule.server !== EXIT_DNS_TAG) {
    fail('config.route.rules[0]', 'must resolve public and health inbound domains through exit-dns');
  }
  if (!sameArray(privateRule.inbound, routedInbounds)
    || privateRule.ip_is_private !== true
    || privateRule.action !== 'reject') {
    fail('config.route.rules[1]', 'must reject non-public destination addresses after resolution');
  }
  if (!sameArray(tailnetRule.inbound, routedInbounds)
    || !sameArray(tailnetRule.ip_cidr, BLOCKED_NON_INTERNET_CIDRS)
    || tailnetRule.action !== 'reject') {
    fail('config.route.rules[2]', 'must reject CGNAT, Tailscale ULA, and other special-use destinations after resolution');
  }
  requireExactKeys(value.dns, ['servers', 'final'], 'config.dns');
  if (!Array.isArray(value.dns.servers) || value.dns.servers.length !== 2 || value.dns.final !== EXIT_DNS_TAG) {
    fail('config.dns', 'must contain only the bootstrap and exit-routed resolvers');
  }
  const bootstrapDns = value.dns.servers.find((server) => server?.tag === BOOTSTRAP_DNS_TAG);
  const exitDns = value.dns.servers.find((server) => server?.tag === EXIT_DNS_TAG);
  requireExactKeys(bootstrapDns, ['type', 'tag'], 'config.dns.bootstrap-dns');
  requireExactKeys(
    exitDns,
    ['type', 'tag', 'server', 'server_port', 'detour'],
    'config.dns.exit-dns',
  );
  if (bootstrapDns.type !== 'local'
    || exitDns.type !== 'udp'
    || exitDns.server !== EXIT_DNS_SERVER
    || exitDns.server_port !== 53
    || exitDns.detour !== TAILSCALE_ENDPOINT_TAG) {
    fail('config.dns', 'destination DNS must use the fixed resolver through the Tailscale endpoint');
  }
  if (!Array.isArray(value.endpoints) || value.endpoints.length !== 1) {
    fail('config.endpoints', 'must contain only the Tailscale endpoint');
  }
  const [endpoint] = value.endpoints;
  requireExactKeys(
    endpoint,
    endpoint && Object.hasOwn(endpoint, 'auth_key')
      ? ['type', 'tag', 'state_directory', 'hostname', 'exit_node', 'ephemeral', 'domain_resolver', 'auth_key']
      : ['type', 'tag', 'state_directory', 'hostname', 'exit_node', 'ephemeral', 'domain_resolver'],
    'config.endpoints[0]',
  );
  if (!isPlainObject(endpoint) || endpoint.type !== 'tailscale' || endpoint.tag !== TAILSCALE_ENDPOINT_TAG) {
    fail('config.endpoints[0]', 'must be the ts-out Tailscale endpoint');
  }
  if (endpoint.ephemeral !== false
    || endpoint.domain_resolver !== BOOTSTRAP_DNS_TAG
    || typeof endpoint.state_directory !== 'string') {
    fail('config.endpoints[0]', 'must use persistent Tailscale state');
  }
  if (!Array.isArray(value.inbounds) || value.inbounds.length !== 2) {
    fail('config.inbounds', 'must contain the public and health inbounds');
  }
  const publicInbound = value.inbounds.find((inbound) => inbound?.tag === PUBLIC_INBOUND_TAG);
  const healthInbound = value.inbounds.find((inbound) => inbound?.tag === HEALTH_INBOUND_TAG);
  if (!publicInbound || publicInbound.type !== 'vless' || !Array.isArray(publicInbound.users)) {
    fail('config.inbounds', 'must contain the public VLESS inbound');
  }
  if (!healthInbound || healthInbound.type !== 'mixed' || healthInbound.listen !== '127.0.0.1') {
    fail('config.inbounds', 'health inbound must be mixed and IPv4 loopback-only');
  }
  requireExactKeys(
    publicInbound,
    ['type', 'tag', 'listen', 'listen_port', 'users', 'transport'],
    'config.inbounds.vless-in',
  );
  requireExactKeys(
    healthInbound,
    ['type', 'tag', 'listen', 'listen_port', 'users'],
    'config.inbounds.health-in',
  );
  if (!Array.isArray(healthInbound.users) || healthInbound.users.length !== 1) {
    fail('config.inbounds.health-in.users', 'must contain exactly one health probe user');
  }
  requireExactKeys(
    healthInbound.users[0],
    ['username', 'password'],
    'config.inbounds.health-in.users[0]',
  );
  const healthUser = healthInbound.users[0];
  const decodedHealthPassword = typeof healthUser.password === 'string'
    ? Buffer.from(healthUser.password, 'base64url')
    : null;
  if (
    healthUser.username !== HEALTH_USERNAME
    || typeof healthUser.password !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(healthUser.password)
    || decodedHealthPassword.length !== HEALTH_PASSWORD_BYTES
    || decodedHealthPassword.toString('base64url') !== healthUser.password
  ) {
    fail('config.inbounds.health-in.users[0]', 'must contain valid SOCKS credentials');
  }
  if (publicInbound.listen !== VLESS_LISTEN_HOST || publicInbound.listen_port !== VLESS_LISTEN_PORT) {
    fail('config.inbounds.vless-in', 'must listen only on the fixed IPv4 loopback origin');
  }
  for (const [index, user] of publicInbound.users.entries()) {
    requireExactKeys(user, ['name', 'uuid'], `config.inbounds.vless-in.users[${index}]`);
    if (typeof user.name !== 'string' || typeof user.uuid !== 'string') {
      fail(`config.inbounds.vless-in.users[${index}]`, 'must be a VLESS user without flow overrides');
    }
  }
  requireExactKeys(publicInbound.transport, ['type', 'path'], 'config.inbounds.vless-in.transport');
  if (publicInbound.transport.type !== 'ws'
    || typeof publicInbound.transport.path !== 'string'
    || !/^\/[A-Za-z0-9_-]{43,128}$/u.test(publicInbound.transport.path)) {
    fail('config.inbounds.vless-in.transport', 'must use the canonical WebSocket path');
  }

  assertSingleExitState({ endpoint, publicInbound, healthInbound }, expectedState);
  return value;
}
