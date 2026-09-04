import assert from 'node:assert/strict';
import test from 'node:test';
import { hashSubscriptionToken } from '../../src/credentials.js';
import {
  assertFailClosedConfig,
  BLOCKED_NON_INTERNET_CIDRS,
  buildSubscriptionView,
  renderClashClientConfig,
  renderMixedSubscription,
  renderSingBoxClientConfig,
  renderSingBoxConfig,
  renderVlessLink,
} from '../../src/render.js';
import { fixtureState, fixtureUser } from './core-v2-fixture.js';

function lifecycleState() {
  return fixtureState({
    updatedAt: '2026-09-04T00:02:00.000Z',
    users: [
      fixtureUser(),
      fixtureUser({
        id: 'bob',
        displayName: 'Bob',
        uuid: '00000000-0000-4000-8000-000000000002',
        tokenHash: hashSubscriptionToken('b'.repeat(32)),
        status: 'disabled',
        updatedAt: '2026-09-04T00:01:00.000Z',
        disabledAt: '2026-09-04T00:01:00.000Z',
      }),
      fixtureUser({
        id: 'carol',
        displayName: 'Carol',
        uuid: '00000000-0000-4000-8000-000000000003',
        tokenHash: hashSubscriptionToken('c'.repeat(32)),
        status: 'revoked',
        updatedAt: '2026-09-04T00:02:00.000Z',
        revokedAt: '2026-09-04T00:02:00.000Z',
      }),
    ],
  });
}

test('server renderer exposes active VLESS users and forces every inbound through ts-out', () => {
  const config = renderSingBoxConfig(lifecycleState());
  const publicInbound = config.inbounds.find((inbound) => inbound.tag === 'vless-in');
  const healthInbound = config.inbounds.find((inbound) => inbound.tag === 'health-in');
  assert.deepEqual(publicInbound.users.map((user) => user.name), ['alice']);
  assert.deepEqual(publicInbound.users.map((user) => user.uuid), [
    '00000000-0000-4000-8000-000000000001',
  ]);
  assert.equal(healthInbound.type, 'mixed');
  assert.equal(healthInbound.listen, '127.0.0.1');
  assert.deepEqual(healthInbound.users, [{
    username: lifecycleState().health.username,
    password: lifecycleState().health.password,
  }]);
  assert.equal(config.route.final, 'ts-out');
  assert.equal(config.route.default_domain_resolver, 'exit-dns');
  assert.deepEqual(config.route.rules, [
    { inbound: ['vless-in', 'health-in'], action: 'resolve', server: 'exit-dns' },
    { inbound: ['vless-in', 'health-in'], ip_is_private: true, action: 'reject' },
    {
      inbound: ['vless-in', 'health-in'],
      ip_cidr: [...BLOCKED_NON_INTERNET_CIDRS],
      action: 'reject',
    },
  ]);
  assert.equal(Object.hasOwn(config, 'outbounds'), false);
  assert.deepEqual(config.endpoints.map((endpoint) => endpoint.tag), ['ts-out']);
  assert.equal(config.endpoints[0].domain_resolver, 'bootstrap-dns');
  assert.deepEqual(config.dns, {
    servers: [
      { type: 'local', tag: 'bootstrap-dns' },
      { type: 'udp', tag: 'exit-dns', server: '1.1.1.1', server_port: 53, detour: 'ts-out' },
    ],
    final: 'exit-dns',
  });
  assert.equal(publicInbound.tls.reality.handshake.detour, 'ts-out');
  assert.doesNotThrow(() => assertFailClosedConfig(config));
});

test('server renderer never copies controller-only API credentials into sing-box', () => {
  const state = fixtureState();
  const configText = JSON.stringify(renderSingBoxConfig(state));
  assert.equal(configText.includes(state.tailscale.apiKey), false);
  assert.equal(configText.includes(state.tailscale.authKey), true);
  assert.equal(configText.includes(state.users[0].tokenHash), false);
  assert.equal(configText.includes(state.health.password), true);

  const unsafe = { ...renderSingBoxConfig(state), outbounds: [{ type: 'direct', tag: 'direct' }] };
  assert.throws(() => assertFailClosedConfig(unsafe), /fallback outbound/);

  const unauthenticated = structuredClone(renderSingBoxConfig(state));
  unauthenticated.inbounds.find((inbound) => inbound.tag === 'health-in').users = [];
  assert.throws(() => assertFailClosedConfig(unauthenticated), /exactly one health probe user/);

  const directRealityFallback = structuredClone(renderSingBoxConfig(state));
  delete directRealityFallback.inbounds
    .find((inbound) => inbound.tag === 'vless-in').tls.reality.handshake.detour;
  assert.throws(() => assertFailClosedConfig(directRealityFallback), /unsupported or missing fields/);

  const directDns = structuredClone(renderSingBoxConfig(state));
  delete directDns.dns.servers.find((server) => server.tag === 'exit-dns').detour;
  assert.throws(() => assertFailClosedConfig(directDns), /unsupported or missing fields/);

  const recursiveBootstrap = structuredClone(renderSingBoxConfig(state));
  recursiveBootstrap.endpoints[0].domain_resolver = 'exit-dns';
  assert.throws(() => assertFailClosedConfig(recursiveBootstrap), /persistent Tailscale state/);

  // Literal private/Tailnet addresses hit the reject rules directly. Domains
  // are resolved first, then the same rules examine every returned A/AAAA.
  const noResolveBeforeReject = structuredClone(renderSingBoxConfig(state));
  [noResolveBeforeReject.route.rules[0], noResolveBeforeReject.route.rules[1]] = [
    noResolveBeforeReject.route.rules[1],
    noResolveBeforeReject.route.rules[0],
  ];
  assert.throws(() => assertFailClosedConfig(noResolveBeforeReject), /config\.route\.rules\[0\]/u);

  const allowsCgnat = structuredClone(renderSingBoxConfig(state));
  allowsCgnat.route.rules[2].ip_cidr = allowsCgnat.route.rules[2].ip_cidr
    .filter((cidr) => cidr !== '100.64.0.0/10');
  assert.throws(() => assertFailClosedConfig(allowsCgnat), /config\.route\.rules\[2\]/u);

  const allowsTailnetUla = structuredClone(renderSingBoxConfig(state));
  allowsTailnetUla.route.rules[2].ip_cidr = allowsTailnetUla.route.rules[2].ip_cidr
    .filter((cidr) => cidr !== 'fd7a:115c:a1e0::/48');
  assert.throws(() => assertFailClosedConfig(allowsTailnetUla), /config\.route\.rules\[2\]/u);

  for (const specialUseCidr of [
    '192.88.99.2/32',
    '64:ff9b::/96',
    '100:0:0:1::/64',
    '2001::/32',
    '2001:2::/48',
    '3fff::/20',
    '5f00::/16',
  ]) {
    assert.equal(
      BLOCKED_NON_INTERNET_CIDRS.includes(specialUseCidr),
      true,
      `${specialUseCidr} must remain blocked`,
    );
  }
});

test('subscription projection contains only public connection data and active token hashes', () => {
  const state = lifecycleState();
  const view = buildSubscriptionView(state);
  assert.deepEqual(view.users.map((user) => user.id), ['alice']);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(state.reality.privateKey), false);
  assert.equal(serialized.includes(state.tailscale.apiKey), false);
  assert.equal(serialized.includes(state.tailscale.authKey), false);
  assert.equal(serialized.includes(state.health.password), false);
});

test('client formats bracket IPv6 authorities and quote hostile YAML scalars', () => {
  const displayName = 'Phone: [primary] #1';
  const state = fixtureState({
    gateway: {
      ...fixtureState().gateway,
      host: { kind: 'ipv6', value: '2001:db8::5' },
    },
    users: [fixtureUser({ displayName })],
  });
  const link = renderVlessLink(state, 'alice');
  assert.match(link, /@\[2001:db8::5\]:443\?/u);
  assert.equal(link.endsWith(`#${encodeURIComponent(displayName)}`), true);

  const singBox = renderSingBoxClientConfig(state, 'alice');
  assert.equal(singBox.outbounds[0].server, '2001:db8::5');
  assert.equal(singBox.route.final, 'proxy');
  assert.equal(singBox.outbounds.some((outbound) => outbound.type === 'direct'), false);

  const clash = renderClashClientConfig(state, 'alice');
  assert.match(clash, /server: "2001:db8::5"/u);
  assert.match(clash, /name: "Phone: \[primary\] #1"/u);
  assert.equal(clash.includes('\n  - name: Phone:'), false);

  assert.equal(Buffer.from(renderMixedSubscription(state, 'alice'), 'base64').toString('utf8'), `${link}\n`);
});
