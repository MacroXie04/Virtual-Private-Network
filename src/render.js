import {
  HEALTH_PASSWORD_BYTES,
  HEALTH_USERNAME,
  SUBSCRIPTION_VIEW_SCHEMA_VERSION,
  validateState,
  validateSubscriptionView,
} from './state-schema.js';
import {
  ValidationError,
  formatAuthorityHost,
  isPlainObject,
  safeYamlScalar,
} from './validation.js';

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

// Exact predecessors used only by the stopped-service policy upgrader. Keeping
// them separate prevents the compatibility path from accepting arbitrary route
// changes while existing v2 volumes receive each narrowly reviewed deny-set
// expansion.
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

export function assertFailClosedConfig(value, expectedState = null) {
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
    ['type', 'tag', 'listen', 'listen_port', 'users', 'tls'],
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
  if (publicInbound.listen !== '::') fail('config.inbounds.vless-in.listen', 'must listen on the dual-stack socket');
  for (const [index, user] of publicInbound.users.entries()) {
    requireExactKeys(user, ['name', 'uuid', 'flow'], `config.inbounds.vless-in.users[${index}]`);
    if (typeof user.name !== 'string' || typeof user.uuid !== 'string' || user.flow !== 'xtls-rprx-vision') {
      fail(`config.inbounds.vless-in.users[${index}]`, 'must be a VLESS Vision user');
    }
  }
  requireExactKeys(publicInbound.tls, ['enabled', 'server_name', 'reality'], 'config.inbounds.vless-in.tls');
  requireExactKeys(
    publicInbound.tls.reality,
    ['enabled', 'handshake', 'private_key', 'short_id'],
    'config.inbounds.vless-in.tls.reality',
  );
  requireExactKeys(
    publicInbound.tls.reality.handshake,
    ['server', 'server_port', 'detour'],
    'config.inbounds.vless-in.tls.reality.handshake',
  );
  if (publicInbound.tls.enabled !== true
    || publicInbound.tls.reality.enabled !== true
    || publicInbound.tls.reality.handshake.server_port !== 443
    || publicInbound.tls.reality.handshake.detour !== TAILSCALE_ENDPOINT_TAG
    || !Array.isArray(publicInbound.tls.reality.short_id)
    || publicInbound.tls.reality.short_id.length !== 1) {
    fail('config.inbounds.vless-in.tls', 'must use the expected REALITY transport');
  }

  if (expectedState !== null) {
    const state = validateState(expectedState);
    const expectedUsers = state.users.filter((user) => user.status === 'active');
    if (publicInbound.users.length !== expectedUsers.length) {
      fail('config.inbounds.vless-in.users', 'does not match active state users');
    }
    expectedUsers.forEach((user, index) => {
      const rendered = publicInbound.users[index];
      if (rendered.name !== user.id || rendered.uuid !== user.uuid || rendered.flow !== 'xtls-rprx-vision') {
        fail(`config.inbounds.vless-in.users[${index}]`, 'does not match active state user');
      }
    });
    if (publicInbound.listen_port !== state.gateway.listenPort
      || healthInbound.listen_port !== state.health.listenPort) {
      fail('config.inbounds', 'listen ports do not match state');
    }
    if (healthInbound.users[0].username !== state.health.username
      || healthInbound.users[0].password !== state.health.password) {
      fail('config.inbounds.health-in.users[0]', 'does not match health probe credentials');
    }
    const reality = publicInbound.tls.reality;
    if (publicInbound.tls.server_name !== state.reality.serverName
      || reality.handshake.server !== state.reality.serverName
      || reality.private_key !== state.reality.privateKey
      || reality.short_id[0] !== state.reality.shortId) {
      fail('config.inbounds.vless-in.tls.reality', 'does not match state');
    }
    if (endpoint.state_directory !== state.tailscale.stateDirectory
      || endpoint.hostname !== state.tailscale.hostname
      || endpoint.exit_node !== state.tailscale.exitNode
      || (state.tailscale.authKey === null
        ? Object.hasOwn(endpoint, 'auth_key')
        : endpoint.auth_key !== state.tailscale.authKey)) {
      fail('config.endpoints[0]', 'does not match state');
    }
  }
  return value;
}

/**
 * Validate the immediately previous schema-v2 renderer policies: the
 * earliest lacked explicit DNS/endpoint resolvers (and sometimes the REALITY
 * detour), the next added routed DNS but not Tailnet isolation rules, and the
 * latest used the first, narrower special-use deny set.
 * This is intentionally not a renderer: it accepts only those exact shapes,
 * upgrades a clone with fixed fields, then subjects it to every current
 * semantic check. Callers may use it only for a stopped-service bootstrap
 * upgrade or post-readiness retirement.
 */
export function assertLegacyV2Config(value, expectedState) {
  const hasRoutedDns = isPlainObject(value) && Object.hasOwn(value, 'dns');
  const hasIsolationRules = hasRoutedDns
    && isPlainObject(value.route)
    && Object.hasOwn(value.route, 'rules');
  requireExactKeys(
    value,
    hasRoutedDns
      ? ['log', 'dns', 'inbounds', 'endpoints', 'route']
      : ['log', 'inbounds', 'endpoints', 'route'],
    'legacyConfig',
  );
  requireExactKeys(
    value.route,
    hasIsolationRules
      ? ['rules', 'final', 'default_domain_resolver']
      : hasRoutedDns ? ['final', 'default_domain_resolver'] : ['final'],
    'legacyConfig.route',
  );
  if (hasIsolationRules) {
    if (!Array.isArray(value.route.rules) || value.route.rules.length !== 3) {
      fail('legacyConfig.route.rules', 'must contain the exact predecessor isolation policy');
    }
    const routedInbounds = [PUBLIC_INBOUND_TAG, HEALTH_INBOUND_TAG];
    const [resolveRule, privateRule, tailnetRule] = value.route.rules;
    requireExactKeys(resolveRule, ['inbound', 'action', 'server'], 'legacyConfig.route.rules[0]');
    requireExactKeys(privateRule, ['inbound', 'ip_is_private', 'action'], 'legacyConfig.route.rules[1]');
    requireExactKeys(tailnetRule, ['inbound', 'ip_cidr', 'action'], 'legacyConfig.route.rules[2]');
    if (!sameArray(resolveRule.inbound, routedInbounds)
      || resolveRule.action !== 'resolve'
      || resolveRule.server !== EXIT_DNS_TAG
      || !sameArray(privateRule.inbound, routedInbounds)
      || privateRule.ip_is_private !== true
      || privateRule.action !== 'reject'
      || !sameArray(tailnetRule.inbound, routedInbounds)
      || !(sameArray(tailnetRule.ip_cidr, PREVIOUS_BLOCKED_NON_INTERNET_CIDRS)
        || sameArray(tailnetRule.ip_cidr, EARLIER_BLOCKED_NON_INTERNET_CIDRS))
      || tailnetRule.action !== 'reject') {
      fail('legacyConfig.route.rules', 'must contain the exact predecessor isolation policy');
    }
  }
  if (!Array.isArray(value.endpoints) || value.endpoints.length !== 1) {
    fail('legacyConfig.endpoints', 'must contain exactly one endpoint');
  }
  const [endpoint] = value.endpoints;
  requireExactKeys(
    endpoint,
    endpoint && Object.hasOwn(endpoint, 'auth_key')
      ? [
        'type', 'tag', 'state_directory', 'hostname', 'exit_node', 'ephemeral',
        ...(hasRoutedDns ? ['domain_resolver'] : []), 'auth_key',
      ]
      : [
        'type', 'tag', 'state_directory', 'hostname', 'exit_node', 'ephemeral',
        ...(hasRoutedDns ? ['domain_resolver'] : []),
      ],
    'legacyConfig.endpoints[0]',
  );
  if (!Array.isArray(value.inbounds)) fail('legacyConfig.inbounds', 'must be an array');
  const publicInbound = value.inbounds.find((inbound) => inbound?.tag === PUBLIC_INBOUND_TAG);
  const handshake = publicInbound?.tls?.reality?.handshake;
  const handshakeKeys = isPlainObject(handshake) && Object.hasOwn(handshake, 'detour')
    ? ['server', 'server_port', 'detour']
    : ['server', 'server_port'];
  requireExactKeys(handshake, handshakeKeys, 'legacyConfig.inbounds.vless-in.tls.reality.handshake');
  if (hasRoutedDns && !Object.hasOwn(handshake, 'detour')) {
    fail('legacyConfig.inbounds.vless-in.tls.reality.handshake', 'routed-DNS policy must include the REALITY detour');
  }

  const upgraded = structuredClone(value);
  if (!hasRoutedDns) {
    upgraded.dns = {
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
    };
    upgraded.endpoints[0].domain_resolver = BOOTSTRAP_DNS_TAG;
    upgraded.route.default_domain_resolver = EXIT_DNS_TAG;
    upgraded.inbounds
      .find((inbound) => inbound?.tag === PUBLIC_INBOUND_TAG)
      .tls.reality.handshake.detour = TAILSCALE_ENDPOINT_TAG;
  }
  upgraded.route.rules = [
    { inbound: [PUBLIC_INBOUND_TAG, HEALTH_INBOUND_TAG], action: 'resolve', server: EXIT_DNS_TAG },
    { inbound: [PUBLIC_INBOUND_TAG, HEALTH_INBOUND_TAG], ip_is_private: true, action: 'reject' },
    {
      inbound: [PUBLIC_INBOUND_TAG, HEALTH_INBOUND_TAG],
      ip_cidr: [...BLOCKED_NON_INTERNET_CIDRS],
      action: 'reject',
    },
  ];
  assertFailClosedConfig(upgraded, expectedState);
  return value;
}

export function renderSingBoxConfig(value) {
  const state = validateState(value);
  const activeUsers = state.users
    .filter((user) => user.status === 'active')
    .map((user) => ({
      name: user.id,
      uuid: user.uuid,
      flow: 'xtls-rprx-vision',
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
        listen: '::',
        listen_port: state.gateway.listenPort,
        users: activeUsers,
        tls: {
          enabled: true,
          server_name: state.reality.serverName,
          reality: {
            enabled: true,
            handshake: {
              server: state.reality.serverName,
              server_port: 443,
              // REALITY forwards unauthenticated camouflage connections to
              // this server. Pin that auxiliary dial to the same Tailscale
              // endpoint so it cannot become a direct VPS-egress exception.
              detour: TAILSCALE_ENDPOINT_TAG,
            },
            private_key: state.reality.privateKey,
            short_id: [state.reality.shortId],
          },
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
  return assertFailClosedConfig(config, state);
}

export function buildSubscriptionView(value) {
  const state = validateState(value);
  return validateSubscriptionView({
    schemaVersion: SUBSCRIPTION_VIEW_SCHEMA_VERSION,
    revision: state.revision,
    gateway: {
      host: state.gateway.host,
      advertisedPort: state.gateway.advertisedPort,
    },
    reality: {
      serverName: state.reality.serverName,
      publicKey: state.reality.publicKey,
      shortId: state.reality.shortId,
    },
    users: state.users
      .filter((user) => user.status === 'active')
      .map((user) => ({
        id: user.id,
        displayName: user.displayName,
        uuid: user.uuid,
        tokenHash: user.tokenHash,
      })),
  });
}

function resolveConnection(value, selector) {
  let source;
  if (value?.schemaVersion === 2) {
    const state = validateState(value);
    source = buildSubscriptionView(state);
  } else {
    source = validateSubscriptionView(value);
  }
  const id = typeof selector === 'string' ? selector : selector?.id;
  const user = source.users.find((candidate) => candidate.id === id);
  if (!user) throw new ValidationError('user', 'must identify an active user');
  return {
    uuid: user.uuid,
    name: user.displayName,
    host: source.gateway.host,
    port: source.gateway.advertisedPort,
    serverName: source.reality.serverName,
    publicKey: source.reality.publicKey,
    shortId: source.reality.shortId,
  };
}

export function renderVlessLink(value, selector) {
  const config = resolveConnection(value, selector);
  const query = new URLSearchParams({
    encryption: 'none',
    flow: 'xtls-rprx-vision',
    security: 'reality',
    sni: config.serverName,
    fp: 'chrome',
    pbk: config.publicKey,
    sid: config.shortId,
    type: 'tcp',
  });
  const authority = formatAuthorityHost(config.host, 'gateway.host');
  return `vless://${config.uuid}@${authority}:${config.port}?${query}#${encodeURIComponent(config.name)}`;
}

export function renderSingBoxClientConfig(value, selector) {
  const config = resolveConnection(value, selector);
  return {
    log: { level: 'info', timestamp: true },
    inbounds: [{
      type: 'mixed',
      tag: 'mixed-in',
      listen: '127.0.0.1',
      listen_port: 7890,
    }],
    outbounds: [{
      type: 'vless',
      tag: 'proxy',
      server: config.host.value,
      server_port: config.port,
      uuid: config.uuid,
      flow: 'xtls-rprx-vision',
      tls: {
        enabled: true,
        server_name: config.serverName,
        utls: { enabled: true, fingerprint: 'chrome' },
        reality: {
          enabled: true,
          public_key: config.publicKey,
          short_id: config.shortId,
        },
      },
    }],
    route: { final: 'proxy' },
  };
}

export function renderClashClientConfig(value, selector) {
  const config = resolveConnection(value, selector);
  const quote = safeYamlScalar;
  return `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
proxies:
  - name: ${quote(config.name)}
    type: vless
    server: ${quote(config.host.value)}
    port: ${config.port}
    uuid: ${quote(config.uuid)}
    network: tcp
    udp: true
    tls: true
    flow: xtls-rprx-vision
    servername: ${quote(config.serverName)}
    client-fingerprint: chrome
    reality-opts:
      public-key: ${quote(config.publicKey)}
      short-id: ${quote(config.shortId)}
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - ${quote(config.name)}
rules:
  - MATCH,PROXY
`;
}

export function renderMixedSubscription(value, selector) {
  return Buffer.from(`${renderVlessLink(value, selector)}\n`, 'utf8').toString('base64');
}

export function renderClientSubscription(value, selector, format = 'links') {
  if (format === 'links') return `${renderVlessLink(value, selector)}\n`;
  if (format === 'mixed') return renderMixedSubscription(value, selector);
  if (format === 'sing-box' || format === 'singbox') {
    return `${JSON.stringify(renderSingBoxClientConfig(value, selector), null, 2)}\n`;
  }
  if (format === 'clash') return renderClashClientConfig(value, selector);
  throw new ValidationError('format', 'must be links, mixed, sing-box, or clash');
}

export const renderSubscriptionView = buildSubscriptionView;
export const buildVlessLink = renderVlessLink;
export const buildSingBoxClientConfig = renderSingBoxClientConfig;
export const buildClashClientConfig = renderClashClientConfig;
export const buildMixedSubscription = renderMixedSubscription;
