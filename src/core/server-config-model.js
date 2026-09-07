import { deriveExitHealthPassword, deriveExitUuid } from './exit-profiles.js';
import { HEALTH_USERNAME, VLESS_LISTEN_HOST, VLESS_LISTEN_PORT } from './state-schema.js';

export const TAILSCALE_ENDPOINT_TAG = 'ts-out';
export const PUBLIC_INBOUND_TAG = 'vless-in';
export const HEALTH_INBOUND_TAG = 'health-in';
export const BOOTSTRAP_DNS_TAG = 'bootstrap-dns';
export const EXIT_DNS_TAG = 'exit-dns';
export const EXIT_DNS_SERVER = '1.1.1.1';
export const BLOCKED_NON_INTERNET_CIDRS = Object.freeze([
  '0.0.0.0/8',
  '100.64.0.0/10',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.2/32',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '240.0.0.0/4',
  '64:ff9b::/96',
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

export function renderServerConfig(state) {
  const activeUsers = state.users
    .filter((user) => user.status === 'active')
    .map((user) => ({
      name: user.id,
      uuid: user.uuid,
    }));
  const endpoint = {
    type: 'tailscale',
    tag: TAILSCALE_ENDPOINT_TAG,
    state_directory: state.tailscale.stateDirectory,
    hostname: state.tailscale.hostname,
    exit_node: state.tailscale.exitNode,
    ephemeral: false,
    // Tailscale must resolve its coordination/DERP bootstrap hosts before the
    // tunnel exists. This is the sole intentionally direct DNS transport.
    domain_resolver: BOOTSTRAP_DNS_TAG,
  };
  if (state.tailscale.authKey !== null) endpoint.auth_key = state.tailscale.authKey;
  const config = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { type: 'local', tag: BOOTSTRAP_DNS_TAG },
        {
          type: 'udp',
          tag: EXIT_DNS_TAG,
          server: EXIT_DNS_SERVER,
          server_port: 53,
          detour: TAILSCALE_ENDPOINT_TAG,
        },
      ],
      final: EXIT_DNS_TAG,
    },
    inbounds: [
      {
        type: 'vless',
        tag: PUBLIC_INBOUND_TAG,
        listen: VLESS_LISTEN_HOST,
        listen_port: VLESS_LISTEN_PORT,
        users: activeUsers,
        transport: {
          type: 'ws',
          path: state.gateway.websocketPath,
        },
      },
      {
        type: 'mixed',
        tag: HEALTH_INBOUND_TAG,
        listen: '127.0.0.1',
        listen_port: state.health.listenPort,
        users: [{
          username: state.health.username,
          password: state.health.password,
        }],
      },
    ],
    endpoints: [endpoint],
    route: {
      rules: [
        {
          inbound: [PUBLIC_INBOUND_TAG, HEALTH_INBOUND_TAG],
          action: 'resolve',
          server: EXIT_DNS_TAG,
        },
        {
          inbound: [PUBLIC_INBOUND_TAG, HEALTH_INBOUND_TAG],
          ip_is_private: true,
          action: 'reject',
        },
        {
          inbound: [PUBLIC_INBOUND_TAG, HEALTH_INBOUND_TAG],
          ip_cidr: [...BLOCKED_NON_INTERNET_CIDRS],
          action: 'reject',
        },
      ],
      final: TAILSCALE_ENDPOINT_TAG,
      default_domain_resolver: EXIT_DNS_TAG,
    },
  };
  const extraExits = state.tailscale.extraExits ?? [];
  if (extraExits.length === 0) return config;

  config.dns.independent_cache = true;
  config.inbounds[0].users = [...activeUsers];
  const profiles = [{
    tag: TAILSCALE_ENDPOINT_TAG,
    dnsTag: EXIT_DNS_TAG,
    users: activeUsers.map((user) => user.name),
    healthUsername: state.health.username,
  }];
  for (const exit of extraExits) {
    const tag = `ts-${exit.id}`;
    const dnsTag = `exit-dns-${exit.id}`;
    const users = activeUsers.map((user) => ({
      name: `${user.name}@${exit.id}`,
      uuid: deriveExitUuid(user.uuid, exit.id),
    }));
    config.inbounds[0].users.push(...users);
    const healthUsername = `${HEALTH_USERNAME}-${exit.id}`;
    config.inbounds[1].users.push({
      username: healthUsername,
      password: deriveExitHealthPassword(state.health.password, exit.id),
    });
    config.endpoints.push({
      type: 'tailscale',
      tag,
      state_directory: `${state.tailscale.stateDirectory}/exits/${exit.id}`,
      hostname: `exit-${exit.id}`,
      exit_node: exit.address,
      ephemeral: false,
      domain_resolver: BOOTSTRAP_DNS_TAG,
      ...(exit.authKey === null ? {} : { auth_key: exit.authKey }),
    });
    config.dns.servers.push({
      type: 'udp', tag: dnsTag, server: EXIT_DNS_SERVER, server_port: 53, detour: tag,
    });
    profiles.push({ tag, dnsTag, users: users.map((user) => user.name), healthUsername });
  }
  const matches = (profile) => [
    ...(profile.users.length > 0
      ? [{ inbound: [PUBLIC_INBOUND_TAG], auth_user: profile.users }]
      : []),
    { inbound: [HEALTH_INBOUND_TAG], auth_user: [profile.healthUsername] },
  ];
  config.route.rules = [
    // Resolve is non-terminal. Every credential matches exactly one resolver.
    ...profiles.flatMap((profile) => matches(profile).map((match) => ({
      ...match, action: 'resolve', server: profile.dnsTag,
    }))),
    ...config.route.rules.slice(1),
    ...profiles.flatMap((profile) => matches(profile).map((match) => ({
      ...match, action: 'route', outbound: profile.tag,
    }))),
    { action: 'reject' },
  ];
  return config;
}
