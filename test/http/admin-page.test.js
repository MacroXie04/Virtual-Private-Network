import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeHtml,
  renderDashboardPage,
  renderLoginPage,
  renderSecretPage,
} from '../../src/http/admin-page.js';

test('admin pages are script-free and escape all state values', () => {
  const page = renderDashboardPage({
    revision: 4,
    csrf: 'csrf<&"',
    gateway: {
      vpnPublicHostname: '<gateway>', publicPort: 443,
      subscriptionPublicBaseUrl: 'https://sub.example.com', adminPublicHostname: '<admin>',
    },
    ready: true,
    users: [{ id: 'user-one', displayName: '<img src=x onerror=alert(1)>', status: 'active' }],
    exitNodes: [{ deviceId: 'exit-one', name: '<script>alert(1)</script>' }],
    exitDirectoryAvailable: true,
  });
  assert.doesNotMatch(page, /<script(?:\s|>)/iu);
  assert.doesNotMatch(page, /<img\s/iu);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(page, /method="post" action="\/users\/user-one\/revoke"/u);
  assert.match(page, /name="csrf" value="csrf&lt;&amp;&quot;"/u);
  const operationIds = [...page.matchAll(/name="operationId" value="([0-9a-f-]+)"/gu)]
    .map((match) => match[1]);
  assert.equal(operationIds.length, 3);
  assert.equal(new Set(operationIds).size, 3);
  for (const operationId of operationIds) {
    assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  }
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});

test('login and one-time credential pages do not contain executable content', () => {
  const login = renderLoginPage({ csrf: 'csrf-token' });
  assert.match(login, /method="post" action="\/login"/u);
  assert.doesNotMatch(login, /<script/iu);

  const secret = renderSecretPage({
    rawToken: '<raw-token>',
    vlessLink: 'vless://value?<script>',
    subscriptionUrl: 'https://example.test/s/token',
  });
  assert.match(secret, /&lt;raw-token&gt;/u);
  assert.match(secret, /&lt;script&gt;/u);
  assert.doesNotMatch(secret, /<script/iu);
});

test('revoked tombstones have no mutation or export controls', () => {
  const page = renderDashboardPage({
    revision: 9,
    csrf: 'csrf',
    gateway: {},
    exitNodes: [],
    users: [{ id: 'gone-user', displayName: 'Gone', status: 'revoked' }],
  });
  assert.match(page, /status: <strong>revoked<\/strong>/u);
  assert.doesNotMatch(page, /\/users\/gone-user\/(?:status|revoke|rotate-token|rotate-credentials|export)/u);
});

test('degraded dashboard permits only an exit-node repair mutation', () => {
  const page = renderDashboardPage({
    revision: 3,
    csrf: 'csrf',
    ready: false,
    gateway: {
      vpnPublicHostname: 'vpn.example.com', publicPort: 443,
      subscriptionPublicBaseUrl: 'https://sub.example.com', adminPublicHostname: 'admin.example.com',
    },
    exitDirectoryAvailable: true,
    exitNodes: [{ deviceId: 'exit-one', name: 'Repair exit' }],
    users: [{ id: 'user-one', displayName: 'Alice', status: 'active' }],
  });
  assert.match(page, /public subscriptions are in maintenance mode/u);
  assert.match(page, /action="\/exit-node"[\s\S]*?<button type="submit">Select exit node/u);
  assert.match(page, /action="\/users"[\s\S]*?<button type="submit" disabled>Create user/u);
  assert.match(page, /action="\/users\/user-one\/rotate-token"[\s\S]*?<button type="submit" disabled>Rotate/u);
  assert.match(page, /action="\/users\/user-one\/rotate-credentials"[\s\S]*?<button type="submit" disabled>Rotate UUID/u);
});
