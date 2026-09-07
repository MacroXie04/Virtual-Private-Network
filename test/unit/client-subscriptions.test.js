import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeHealth, renderSingBoxConfig } from '../../src/core/server-render.js';
import { buildSubscriptionView } from '../../src/core/subscription-view.js';
import {
  renderClashClientConfig,
  renderClientSubscription,
  renderMixedSubscription,
  renderSingBoxClientConfig,
  renderVlessLink,
  renderVlessLinks,
} from '../../src/core/client-subscriptions.js';
import { fixtureState, fixtureUser } from '../fixtures/state.js';

import { lifecycleState, multipleExitState } from '../fixtures/render-state.js';

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

test('subscriptions expose every selectable exit with matching server credentials', () => {
  const state = multipleExitState();
  const view = buildSubscriptionView(state);
  const server = renderSingBoxConfig(state);
  const links = renderVlessLinks(view, 'alice');
  assert.equal(links.length, 3);
  assert.equal(renderVlessLink(view, 'alice'), links[0]);
  assert.deepEqual(links.map((link) => new URL(link).username),
    server.inbounds[0].users.map(({ uuid }) => uuid));
  assert.deepEqual(links.map((link) => decodeURIComponent(new URL(link).hash.slice(1))),
    ['Default', 'seoul', 'tokyo']);
  assert.equal(renderClientSubscription(state, 'alice', 'links'), `${links.join('\n')}\n`);
  assert.equal(Buffer.from(renderMixedSubscription(view, 'alice'), 'base64').toString(), `${links.join('\n')}\n`);
  const client = renderSingBoxClientConfig(view, 'alice');
  assert.deepEqual(client.outbounds[0], {
    type: 'selector', tag: 'PROXY', outbounds: ['Default', 'seoul', 'tokyo'], default: 'Default',
  });
  assert.equal(client.route.final, 'PROXY');
  assert.deepEqual(client.outbounds.slice(1).map(({ uuid }) => uuid),
    server.inbounds[0].users.map(({ uuid }) => uuid));
  const clash = renderClashClientConfig(view, 'alice');
  assert.equal((clash.match(/type: vless/gu) ?? []).length, 3);
  assert.match(clash, /proxies:\n      - "Default"\n      - "seoul"\n      - "tokyo"/u);
  for (const user of server.inbounds[0].users) assert.ok(clash.includes(user.uuid));
  assert.throws(() => renderVlessLinks(view, 'bob'), /active user/u);
  assert.equal(Object.hasOwn(buildRuntimeHealth(fixtureState()), 'profiles'), false);
});
