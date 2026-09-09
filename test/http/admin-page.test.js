import assert from 'node:assert/strict';
import test from 'node:test';
import { exitProfileId } from '../../src/core/identity/exit-profiles.js';
import { escapeHtml } from '../../src/http/admin/pages/document.js';
import { renderDashboardPage } from '../../src/http/admin/pages/dashboard.js';
import { renderErrorPage, renderLoginPage, renderSecretPage } from '../../src/http/admin/pages/access.js';

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

test('degraded dashboard permits default selection and published-exit removal for repair', () => {
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
    selectableExits: [{ id: 'abcdef0123456789', name: 'Unavailable exit', address: '100.64.0.2' }],
    users: [{ id: 'user-one', displayName: 'Alice', status: 'active' }],
  });
  assert.match(page, /public subscriptions are in maintenance mode/u);
  assert.match(page, /action="\/exit-node"[\s\S]*?<button type="submit">Select exit node/u);
  assert.match(page, /action="\/exit-nodes\/abcdef0123456789\/remove"[\s\S]*?<button type="submit">Remove from subscriptions/u);
  assert.match(page, /action="\/exit-nodes"[\s\S]*?<button type="submit" disabled>Add to subscriptions/u);
  assert.match(page, /action="\/users"[\s\S]*?<button type="submit" disabled>Create user/u);
  assert.match(page, /action="\/users\/user-one\/rotate-token"[\s\S]*?<button type="submit" disabled>Rotate/u);
  assert.match(page, /action="\/users\/user-one\/rotate-credentials"[\s\S]*?<button type="submit" disabled>Rotate UUID/u);
});

test('published exits escape directory labels and preserve removal without a directory', () => {
  const page = renderDashboardPage({
    revision: 8,
    csrf: 'csrf<&"',
    exitDirectoryAvailable: false,
    selectableExits: [
      { id: '0123456789abcdef', name: '<img src=x>', address: '<script>address</script>' },
      { id: '../injected', name: 'Unsafe route', address: '100.64.0.3' },
    ],
  });
  assert.match(page, /&lt;img src=x&gt;/u);
  assert.match(page, /&lt;script&gt;address&lt;\/script&gt;/u);
  assert.doesNotMatch(page, /<img|<script|Unsafe route/u);
  assert.match(page, /action="\/exit-nodes\/0123456789abcdef\/remove"[\s\S]*?name="expectedRevision" value="8"/u);
  assert.doesNotMatch(page, /action="\/exit-nodes"/u);
});

test('published exit limit disables adding while leaving removal available', () => {
  const page = renderDashboardPage({
    revision: 8,
    csrf: 'csrf',
    ready: true,
    exitDirectoryAvailable: true,
    exitNodes: [{ deviceId: 'exit-one', name: 'Available exit' }],
    selectableExits: Array.from({ length: 15 }, (_, index) => ({
      id: index.toString(16).padStart(16, '0'), name: `Exit ${index}`, address: '100.64.0.2',
    })),
  });
  assert.match(page, /action="\/exit-nodes"[\s\S]*?<button type="submit" disabled>Add to subscriptions/u);
  assert.equal([...page.matchAll(/<button type="submit">Remove from subscriptions/gu)].length, 15);
});

test('adding an exit excludes default and published devices without restricting default switching', () => {
  const nodes = [
    { deviceId: 'default-device', name: 'default-exit', ipv4: '100.64.0.2' },
    { deviceId: 'published-device', name: 'renamed-exit', ipv4: '100.64.0.3' },
    { deviceId: 'same-address', name: 'address-match', ipv6: 'fd7a:115c:a1e0::4' },
    { deviceId: 'same-name', name: 'name-match', ipv4: '100.64.0.5' },
    { deviceId: 'new-device', name: 'new-exit', ipv4: '100.64.0.6' },
  ];
  const snapshot = {
    revision: 8, csrf: 'csrf', ready: true, exitDirectoryAvailable: true,
    gateway: { exitNode: { deviceId: 'default-device', address: '100.64.0.2' } },
    exitNodes: nodes,
    selectableExits: [
      { id: exitProfileId('published-device'), name: 'old-name', address: '100.64.1.3' },
      { id: exitProfileId('old-address-device'), name: 'old-address-name', address: 'fd7a:115c:a1e0::4' },
      { id: exitProfileId('old-name-device'), name: 'name-match', address: '100.64.1.5' },
    ],
  };
  for (const defaultExit of [
    { deviceId: 'default-device' }, { address: '100.64.0.2' }, { address: 'default-exit' },
  ]) {
    const page = renderDashboardPage({ ...snapshot, gateway: { exitNode: defaultExit } });
    const addForm = page.match(/<form method="post" action="\/exit-nodes">[\s\S]*?<\/form>/u)?.[0];
    assert.ok(addForm);
    assert.deepEqual([...addForm.matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1]), ['new-device']);
    const defaultForm = page.match(/<form method="post" action="\/exit-node">[\s\S]*?<\/form>/u)?.[0];
    assert.deepEqual([...defaultForm.matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1]),
      nodes.map(({ deviceId }) => deviceId));
  }
  const fullyPublished = renderDashboardPage({ ...snapshot, exitNodes: nodes.slice(0, -1) });
  assert.doesNotMatch(fullyPublished, /action="\/exit-nodes"/u);
  assert.match(fullyPublished, /No additional exit nodes are available to add/u);
});

test('exit setup failures display actionable fixed messages and never echo unknown error text', () => {
  for (const [code, expected] of [
    ['ENROLLMENT_KEY_REQUIRED', /Configure a Tailscale enrollment key/u],
    ['ENROLLMENT_KEY_UNAVAILABLE', /enrollment key is unavailable/u],
    ['EXIT_ALREADY_PUBLISHED', /already the default exit or published/u],
    ['EXIT_LIMIT_REACHED', /limit of 15 additional exits/u],
    ['EXIT_DIRECTORY_REQUIRED', /Configure the Tailscale API credential/u],
    ['EXIT_DIRECTORY_UNAVAILABLE', /directory is unavailable/u],
  ]) {
    const page = renderErrorPage(409, code);
    assert.match(page, expected);
    assert.doesNotMatch(page, /State changed/u);
  }
  assert.match(renderErrorPage(409, 'STALE_REVISION'), /State changed; reload and try again/u);
  const untrusted = renderErrorPage(503, '<script>secret-credential</script>');
  assert.match(untrusted, /Request failed/u);
  assert.doesNotMatch(untrusted, /script|secret-credential/u);
});
