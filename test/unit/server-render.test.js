import assert from 'node:assert/strict';
import test from 'node:test';
import { hashSubscriptionToken } from '../../src/core/identity/credentials.js';
import { deriveExitUuid, exitProfileId } from '../../src/core/identity/exit-profiles.js';
import { assertFailClosedConfig } from '../../src/core/server/assert.js';
import { BLOCKED_NON_INTERNET_CIDRS } from '../../src/core/server/model.js';
import { buildRuntimeHealth, renderSingBoxConfig } from '../../src/core/server/render.js';

import { renderSingBoxClientConfig, renderVlessLinks } from '../../src/core/subscriptions/clients.js';
import { fixtureState, fixtureUser } from '../fixtures/state.js';

import { lifecycleState, multipleExitState } from '../fixtures/render-state.js';

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

test('every exit has isolated DNS and credential-selected routes after the shared address rejects', () => {
  const state = multipleExitState();
  const config = renderSingBoxConfig(state);
  assert.equal(config.dns.independent_cache, true);
  assert.equal(config.endpoints.length, 3);
  assert.equal(config.inbounds[0].users.length, 3);
  assert.deepEqual(config.inbounds[0].users[0], { name: 'alice', uuid: state.users[0].uuid });
  assert.deepEqual(config.inbounds[0].users.slice(1).map(({ uuid }) => uuid),
    state.tailscale.extraExits.map(({ id }) => deriveExitUuid(state.users[0].uuid, id)));
  const health = buildRuntimeHealth(state);
  assert.deepEqual(health.profiles, config.inbounds[1].users);
  assert.equal(health.listenPort, state.health.listenPort);
  assert.equal(health.username, state.health.username);
  assert.deepEqual(config.route.rules.at(-1), { action: 'reject' });
  const tags = ['ts-out', ...state.tailscale.extraExits.map(({ id }) => `ts-${id}`)];
  const dnsTags = ['exit-dns', ...state.tailscale.extraExits.map(({ id }) => `exit-dns-${id}`)];
  const firstRoute = config.route.rules.findIndex(({ action }) => action === 'route');
  const addressRejects = config.route.rules.filter(({ action, inbound }) => action === 'reject' && inbound);
  assert.equal(addressRejects.length, 2);
  assert.ok(addressRejects.every((rule) => config.route.rules.indexOf(rule) < firstRoute));
  for (let index = 0; index < tags.length; index += 1) {
    for (const [inbound, username] of [
      ['vless-in', config.inbounds[0].users[index].name],
      ['health-in', health.profiles[index].username],
    ]) {
      const matching = config.route.rules.filter((rule) => rule.inbound?.includes(inbound)
        && rule.auth_user?.includes(username));
      assert.deepEqual(matching.map(({ action }) => action), ['resolve', 'route']);
      assert.equal(matching[0].server, dnsTags[index]);
      assert.equal(matching[1].outbound, tags[index]);
    }
    const dns = config.dns.servers.find(({ tag }) => tag === dnsTags[index]);
    assert.equal(dns.detour, tags[index]);
  }
  for (const [index, exit] of state.tailscale.extraExits.entries()) {
    const endpoint = config.endpoints[index + 1];
    assert.equal(endpoint.state_directory, `${state.tailscale.stateDirectory}/exits/${exit.id}`);
    assert.equal(endpoint.hostname, `exit-${exit.id}`);
    assert.equal(endpoint.exit_node, exit.address);
    assert.equal(endpoint.auth_key, exit.authKey ?? undefined);
  }
  assert.doesNotThrow(() => assertFailClosedConfig(config));
  assert.doesNotThrow(() => assertFailClosedConfig(config, state));
});

test('health-like public usernames cannot select another exit health route', () => {
  const state = multipleExitState();
  state.users[0].id = `vpn-health-${state.tailscale.extraExits[0].id}`;
  const config = renderSingBoxConfig(state);
  const rules = config.route.rules.filter((rule) => rule.inbound?.includes('vless-in')
    && rule.auth_user?.includes(state.users[0].id));
  assert.deepEqual(rules.map(({ action }) => action), ['resolve', 'route']);
  assert.equal(rules[0].server, 'exit-dns');
  assert.equal(rules[1].outbound, 'ts-out');
});

test('strict multi-exit assertion rejects DNS leaks, credential swaps, unmatched routing, and changed exits', () => {
  const state = multipleExitState();
  const rendered = renderSingBoxConfig(state);
  const mutations = [
    (config) => { delete config.dns.independent_cache; },
    (config) => { config.dns.independent_cache = false; },
    (config) => { config.dns.servers[2].detour = 'ts-out'; },
    (config) => { delete config.dns.servers[2].detour; },
    (config) => { delete config.route.rules[0].auth_user; },
    (config) => { config.route.rules[2].server = 'exit-dns'; },
    (config) => { config.route.rules = config.route.rules.filter((rule) => !rule.ip_is_private); },
    (config) => { config.route.rules.find((rule) => rule.ip_cidr).ip_cidr.pop(); },
    (config) => { config.route.rules.pop(); },
    (config) => { config.route.rules.find((rule) => rule.action === 'route').outbound = 'direct'; },
    (config) => { config.inbounds[0].users[1].uuid = config.inbounds[0].users[2].uuid; },
    (config) => { config.inbounds[0].users[1].name = 'different'; },
    (config) => { config.inbounds[1].users[1].password = config.inbounds[1].users[2].password; },
    (config) => { config.endpoints[1].state_directory = config.endpoints[0].state_directory; },
    (config) => { config.endpoints[1].exit_node = '1.1.1.1'; },
    (config) => { config.outbounds = [{ type: 'direct', tag: 'direct' }]; },
  ];
  for (const mutate of mutations) {
    const config = structuredClone(rendered);
    mutate(config);
    assert.throws(() => assertFailClosedConfig(config));
    assert.throws(() => assertFailClosedConfig(config, state));
  }
  const changedExit = structuredClone(rendered);
  changedExit.endpoints[1].exit_node = '100.64.0.99';
  assert.throws(() => assertFailClosedConfig(changedExit, state), /selected state/u);
  const changedKey = structuredClone(rendered);
  changedKey.endpoints[2].auth_key = 'tskey-auth-different';
  assert.throws(() => assertFailClosedConfig(changedKey, state), /selected state/u);
});

test('zero active users still have isolated probes without empty public auth matchers', () => {
  const state = multipleExitState();
  state.users = [];
  const config = renderSingBoxConfig(state);
  assert.deepEqual(config.inbounds[0].users, []);
  assert.equal(config.inbounds[1].users.length, 3);
  assert.equal(config.route.rules.some((rule) => rule.auth_user?.length === 0), false);
  assert.doesNotThrow(() => assertFailClosedConfig(config));
});

test('all 15 extra exits derive only from each original user and remain selectable', () => {
  const state = fixtureState({ users: [
    fixtureUser(),
    fixtureUser({
      id: 'bob', displayName: 'Bob', uuid: '00000000-0000-4000-8000-000000000002',
      tokenHash: hashSubscriptionToken('b'.repeat(32)),
    }),
  ] });
  state.tailscale.extraExits = Array.from({ length: 15 }, (_, index) => ({
    id: exitProfileId(`device-${index}`), name: `exit-${index}`, address: `100.64.1.${index + 1}`, authKey: null,
  }));
  const config = renderSingBoxConfig(state);
  assert.equal(config.endpoints.length, 16);
  assert.equal(config.inbounds[0].users.length, 32);
  assert.equal(config.inbounds[1].users.length, 16);
  assert.equal(buildRuntimeHealth(state).profiles.length, 16);
  for (const user of state.users) {
    const expected = [user.uuid, ...state.tailscale.extraExits.map(({ id }) => deriveExitUuid(user.uuid, id))];
    assert.deepEqual(config.inbounds[0].users.filter(({ name }) => name === user.id || name.startsWith(`${user.id}@`))
      .map(({ uuid }) => uuid), expected);
    assert.deepEqual(renderVlessLinks(state, user.id).map((link) => new URL(link).username), expected);
    assert.equal(renderSingBoxClientConfig(state, user.id).outbounds[0].outbounds.length, 16);
  }
  assert.doesNotThrow(() => assertFailClosedConfig(config));
});
