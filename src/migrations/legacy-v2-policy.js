import { isDeepStrictEqual } from 'node:util';
import { BLOCKED_NON_INTERNET_CIDRS } from '../core/server-config-model.js';
import { ValidationError } from '../core/validation.js';
import { validateLegacyV2State } from './legacy-v2-state.js';

// These are the only two historical deny-set variants that the schema-v2
// reader supported before the ingress cutover. Keep them quarantined here so
// authenticated installed volumes can migrate without widening active policy.
const PREVIOUS_BLOCKED_NON_INTERNET_CIDRS = Object.freeze([
  '0.0.0.0/8',
  '100.64.0.0/10',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.2/32',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '240.0.0.0/4',
  '64:ff9b:1::/48',
  '100::/64',
  '100:0:0:1::/64',
  '2001::/32',
  '2001:2::/48',
  '2001:10::/28',
  '2001:db8::/32',
  '2002::/16',
  '3fff::/20',
  '5f00::/16',
  'fd7a:115c:a1e0::/48',
]);
const EARLIER_BLOCKED_NON_INTERNET_CIDRS = Object.freeze([
  '0.0.0.0/8',
  '100.64.0.0/10',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '240.0.0.0/4',
  '64:ff9b:1::/48',
  '100::/64',
  '2001:10::/28',
  '2001:db8::/32',
  '2002::/16',
  'fd7a:115c:a1e0::/48',
]);

function activeUsers(state) {
  return state.users.filter((user) => user.status === 'active');
}

export function renderLegacyV2Config(value) {
  const state = validateLegacyV2State(value);
  const endpoint = {
    type: 'tailscale',
    tag: 'ts-out',
    state_directory: state.tailscale.stateDirectory,
    hostname: state.tailscale.hostname,
    exit_node: state.tailscale.exitNode,
    ephemeral: false,
    domain_resolver: 'bootstrap-dns',
  };
  if (state.tailscale.authKey !== null) endpoint.auth_key = state.tailscale.authKey;
  return {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { type: 'local', tag: 'bootstrap-dns' },
        { type: 'udp', tag: 'exit-dns', server: '1.1.1.1', server_port: 53, detour: 'ts-out' },
      ],
      final: 'exit-dns',
    },
    inbounds: [
      {
        type: 'vless',
        tag: 'vless-in',
        listen: '::',
        listen_port: state.gateway.listenPort,
        users: activeUsers(state).map((user) => ({
          name: user.id,
          uuid: user.uuid,
          flow: 'xtls-rprx-vision',
        })),
        tls: {
          enabled: true,
          server_name: state.reality.serverName,
          reality: {
            enabled: true,
            handshake: {
              server: state.reality.serverName,
              server_port: 443,
              detour: 'ts-out',
            },
            private_key: state.reality.privateKey,
            short_id: [state.reality.shortId],
          },
        },
      },
      {
        type: 'mixed',
        tag: 'health-in',
        listen: '127.0.0.1',
        listen_port: state.health.listenPort,
        users: [{ username: state.health.username, password: state.health.password }],
      },
    ],
    endpoints: [endpoint],
    route: {
      rules: [
        { inbound: ['vless-in', 'health-in'], action: 'resolve', server: 'exit-dns' },
        { inbound: ['vless-in', 'health-in'], ip_is_private: true, action: 'reject' },
        {
          inbound: ['vless-in', 'health-in'],
          ip_cidr: [...BLOCKED_NON_INTERNET_CIDRS],
          action: 'reject',
        },
      ],
      final: 'ts-out',
      default_domain_resolver: 'exit-dns',
    },
  };
}

export function renderLegacyV2SubscriptionView(value) {
  const state = validateLegacyV2State(value);
  return {
    schemaVersion: 1,
    revision: state.revision,
    gateway: { host: state.gateway.host, advertisedPort: state.gateway.advertisedPort },
    reality: {
      serverName: state.reality.serverName,
      publicKey: state.reality.publicKey,
      shortId: state.reality.shortId,
    },
    users: activeUsers(state).map((user) => ({
      id: user.id,
      displayName: user.displayName,
      uuid: user.uuid,
      tokenHash: user.tokenHash,
    })),
  };
}

function legacyConfigVariants(state) {
  const current = renderLegacyV2Config(state);
  const previousDenySet = structuredClone(current);
  previousDenySet.route.rules[2].ip_cidr = [...PREVIOUS_BLOCKED_NON_INTERNET_CIDRS];
  const earlierDenySet = structuredClone(current);
  earlierDenySet.route.rules[2].ip_cidr = [...EARLIER_BLOCKED_NON_INTERNET_CIDRS];

  const routedDnsWithoutIsolation = structuredClone(current);
  delete routedDnsWithoutIsolation.route.rules;

  const earliestWithDetour = structuredClone(routedDnsWithoutIsolation);
  delete earliestWithDetour.dns;
  delete earliestWithDetour.route.default_domain_resolver;
  delete earliestWithDetour.endpoints[0].domain_resolver;

  const earliestWithoutDetour = structuredClone(earliestWithDetour);
  delete earliestWithoutDetour.inbounds
    .find((inbound) => inbound.tag === 'vless-in').tls.reality.handshake.detour;

  return [
    current,
    previousDenySet,
    earlierDenySet,
    routedDnsWithoutIsolation,
    earliestWithDetour,
    earliestWithoutDetour,
  ];
}

export function validateLegacyV2Revision(rawState, rawConfig, rawView) {
  const state = validateLegacyV2State(rawState);
  const expectedView = renderLegacyV2SubscriptionView(state);
  if (!legacyConfigVariants(state).some((candidate) => isDeepStrictEqual(rawConfig, candidate))
    || !isDeepStrictEqual(rawView, expectedView)) {
    throw new ValidationError('legacyRevision', 'does not match an exact supported schema-v2 renderer');
  }
  return { state, config: rawConfig, subscriptionView: rawView };
}
