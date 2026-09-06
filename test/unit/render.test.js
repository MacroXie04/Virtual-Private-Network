import assert from 'node:assert/strict';
import test from 'node:test';
import { hashSubscriptionToken } from '../../src/core/credentials.js';
import {
  assertFailClosedConfig,
  BLOCKED_NON_INTERNET_CIDRS,
  buildSubscriptionView,
  renderClashClientConfig,
  renderMixedSubscription,
  renderSingBoxClientConfig,
  renderSingBoxConfig,
  renderVlessLink,
} from '../../src/core/render.js';
import { fixtureState, fixtureUser } from '../fixtures/state.js';

function lifecycleState() {
  return fixtureState({
    updatedAt: '2026-09-04T00:02:00.000Z',
    users: [
      fixtureUser(),
      fixtureUser({
        id: 'bob', displayName: 'Bob', uuid: '00000000-0000-4000-8000-000000000002',
        tokenHash: hashSubscriptionToken('b'.repeat(32)), status: 'disabled',
        updatedAt: '2026-09-04T00:01:00.000Z', disabledAt: '2026-09-04T00:01:00.000Z',
      }),
      fixtureUser({
        id: 'carol', displayName: 'Carol', uuid: '00000000-0000-4000-8000-000000000003',
        tokenHash: hashSubscriptionToken('c'.repeat(32)), status: 'revoked',
        updatedAt: '2026-09-04T00:02:00.000Z', revokedAt: '2026-09-04T00:02:00.000Z',
      }),
    ],
  });
}

test('server renderer uses only loopback VLESS WebSocket and the ts-out final route', () => {
  const config = renderSingBoxConfig(lifecycleState());
  const inbound = config.inbounds.find((entry) => entry.tag === 'vless-in');
  assert.deepEqual(inbound, {
    type: 'vless', tag: 'vless-in', listen: '127.0.0.1', listen_port: 8443,
    users: [{ name: 'alice', uuid: '00000000-0000-4000-8000-000000000001' }],
    transport: { type: 'ws', path: lifecycleState().gateway.websocketPath },
  });
  assert.equal(Object.hasOwn(inbound, 'tls'), false);
  assert.equal(config.route.final, 'ts-out');
  assert.equal(config.route.default_domain_resolver, 'exit-dns');
  assert.deepEqual(config.route.rules, [
    { inbound: ['vless-in', 'health-in'], action: 'resolve', server: 'exit-dns' },
    { inbound: ['vless-in', 'health-in'], ip_is_private: true, action: 'reject' },
    { inbound: ['vless-in', 'health-in'], ip_cidr: [...BLOCKED_NON_INTERNET_CIDRS], action: 'reject' },
  ]);
  assert.equal(Object.hasOwn(config, 'outbounds'), false);
  assert.deepEqual(config.endpoints.map((endpoint) => endpoint.tag), ['ts-out']);
  assert.doesNotThrow(() => assertFailClosedConfig(config, lifecycleState()));
});

test('server assertion rejects direct fallback and transport weakening', () => {
  const state = fixtureState();
  const rendered = renderSingBoxConfig(state);
  assert.equal(JSON.stringify(rendered).includes(state.tailscale.apiKey), false);
  assert.equal(JSON.stringify(rendered).includes(state.users[0].tokenHash), false);
  const direct = { ...rendered, outbounds: [{ type: 'direct', tag: 'direct' }] };
  assert.throws(() => assertFailClosedConfig(direct), /fallback outbound/);
  const tlsOrigin = structuredClone(rendered);
  tlsOrigin.inbounds[0].tls = { enabled: true };
  assert.throws(() => assertFailClosedConfig(tlsOrigin), /unsupported or missing fields/);
  const wrongPath = structuredClone(rendered);
  wrongPath.inbounds[0].transport.path = `/${'B'.repeat(43)}`;
  assert.throws(() => assertFailClosedConfig(wrongPath, state), /does not match state/);
  const directDns = structuredClone(rendered);
  delete directDns.dns.servers.find((server) => server.tag === 'exit-dns').detour;
  assert.throws(() => assertFailClosedConfig(directDns), /unsupported or missing fields/);
  const allowsCgnat = structuredClone(rendered);
  allowsCgnat.route.rules[2].ip_cidr = allowsCgnat.route.rules[2].ip_cidr.filter((cidr) => cidr !== '100.64.0.0/10');
  assert.throws(() => assertFailClosedConfig(allowsCgnat), /rules\[2\]/u);
});

test('projection excludes private state and every client format is VLESS WebSocket TLS', () => {
  const state = lifecycleState();
  const view = buildSubscriptionView(state);
  assert.deepEqual(view.users.map((user) => user.id), ['alice']);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(state.tailscale.apiKey), false);
  assert.equal(serialized.includes(state.tailscale.authKey), false);
  assert.equal(serialized.includes(state.health.password), false);
  const link = renderVlessLink(state, 'alice');
  const parsed = new URL(link);
  assert.equal(parsed.hostname, 'vpn.example.com');
  assert.equal(parsed.port, '443');
  assert.equal(parsed.searchParams.get('security'), 'tls');
  assert.equal(parsed.searchParams.get('type'), 'ws');
  assert.equal(parsed.searchParams.get('host'), 'vpn.example.com');
  assert.equal(parsed.searchParams.get('path'), state.gateway.websocketPath);
  for (const forbidden of ['pbk=', 'sid=', 'fp=', 'flow=']) assert.equal(link.includes(forbidden), false);
  const singBox = renderSingBoxClientConfig(state, 'alice').outbounds[0];
  assert.deepEqual(singBox.tls, { enabled: true, server_name: 'vpn.example.com' });
  assert.deepEqual(singBox.transport, {
    type: 'ws', path: state.gateway.websocketPath, headers: { Host: 'vpn.example.com' },
  });
  assert.equal(Object.hasOwn(singBox, 'flow'), false);
  const clash = renderClashClientConfig(state, 'alice');
  assert.match(clash, /network: ws/u);
  assert.match(clash, /tls: true/u);
  assert.match(clash, /servername: "vpn\.example\.com"/u);
  assert.match(clash, /Host: "vpn\.example\.com"/u);
  assert.equal(clash.includes('reality-opts'), false);
  assert.equal(Buffer.from(renderMixedSubscription(state, 'alice'), 'base64').toString('utf8'), `${link}\n`);
});

test('client formats safely encode display names that contain YAML syntax', () => {
  const displayName = 'Phone: [primary] #1';
  const state = fixtureState({ users: [fixtureUser({ displayName })] });

  const link = new URL(renderVlessLink(state, 'alice'));
  assert.equal(decodeURIComponent(link.hash.slice(1)), displayName);

  const singBox = renderSingBoxClientConfig(state, 'alice');
  assert.equal(singBox.outbounds[0].server, 'vpn.example.com');

  const clash = renderClashClientConfig(state, 'alice');
  assert.match(clash, /name: "Phone: \[primary\] #1"/u);
  assert.doesNotMatch(clash, /name: Phone: \[primary\] #1/u);
});
