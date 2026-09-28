import assert from 'node:assert/strict';
import test from 'node:test';
import { exitProfileId } from '../../src/core/identity/exit-profiles.js';
import { escapeHtml } from '../../src/http/admin/pages/document.js';
import { renderExitNodesPage, renderOverviewPage, renderUsersPage } from '../../src/http/admin/pages/dashboard.js';
import { renderErrorPage, renderHomePage, renderLoginPage } from '../../src/http/admin/pages/access.js';
import { renderCredentialsCard } from '../../src/http/admin/pages/users.js';

const renderAll = (snapshot, options) => [
  renderOverviewPage(snapshot, options),
  renderExitNodesPage(snapshot, options),
  renderUsersPage(snapshot, options),
].join('\n');

test('admin pages are script-free and escape all state values', () => {
  const page = renderAll({
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

test('the public home page is constant, script-free and links only to the two realms', () => {
  const home = renderHomePage();
  assert.match(renderHomePage.toString(), /^function renderHomePage\(\)\s*\{/u);
  assert.equal(home, renderHomePage());
  assert.match(home, /<html lang="en">/u);
  assert.match(home, /<meta name="robots" content="noindex, nofollow">/u);
  assert.match(home, /<link rel="stylesheet" href="\/assets\/admin\.css">/u);
  assert.match(home, /<title>VPN Gateway<\/title>/u);
  assert.match(home, /<div class="auth-inner auth-inner-wide">/u);
  assert.match(home, /<h1 id="home-title" class="brand">/u);
  assert.match(home, /<a class="btn btn-primary btn-block" href="\/account">Sign in to your account<\/a>/u);
  assert.match(home, /aria-labelledby="connect-title"[\s\S]*<ol class="steps">[\s\S]*aria-labelledby="help-title"/u);
  assert.match(home, /subscription link your administrator gave you/u);
  assert.match(home, /<p class="meta"><a href="\/overview">Administration<\/a><\/p>/u);
  assert.deepEqual([...home.matchAll(/href="([^"]*)"/gu)].map((match) => match[1]), ['/assets/admin.css', '/account', '/overview']);
  assert.doesNotMatch(home, /<script|<form|<img|name="csrf"|name="expectedRevision"|name="operationId"|aria-current|vless:\/\/|Gateway overview|Sign out|Maintenance mode/iu);
});

test('login and one-time credential pages do not contain executable content', () => {
  const login = renderLoginPage({ csrf: 'csrf-token' });
  assert.match(login, /method="post" action="\/login"/u);
  assert.doesNotMatch(login, /<script/iu);
  assert.match(login, /<a href="\/">Home<\/a> · <a href="\/account\/login">User sign-in<\/a>/u);

  const secret = renderCredentialsCard({
    rawToken: '<raw-token>',
    vlessLink: 'vless://value?<script>',
    subscriptionUrl: 'https://example.test/s/token',
  });
  assert.match(secret, /&lt;raw-token&gt;/u);
  assert.match(secret, /&lt;script&gt;/u);
  assert.doesNotMatch(secret, /<script/iu);
});

test('revoked tombstones have no mutation or export controls', () => {
  const page = renderAll({
    revision: 9,
    csrf: 'csrf',
    gateway: {},
    exitNodes: [],
    users: [{ id: 'gone-user', displayName: 'Gone', status: 'revoked' }],
  });
  assert.match(page, /badge-revoked">Revoked/u);
  assert.doesNotMatch(page, /\/users\/gone-user\/(?:status|revoke|reset-password|rotate-token|rotate-credentials|export)/u);
  assert.doesNotMatch(page, /No portal password/u);
});

test('degraded dashboard permits default selection and published-exit removal for repair', () => {
  const page = renderAll({
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
  assert.match(page, /action="\/exit-node"[\s\S]*?<button type="submit" class="btn btn-primary">Select exit node/u);
  assert.match(page, /action="\/exit-nodes\/abcdef0123456789\/remove"[\s\S]*?<button type="submit" class="btn btn-danger-ghost">Remove from subscriptions/u);
  assert.match(page, /action="\/exit-nodes"[\s\S]*?<button type="submit" class="btn btn-primary" disabled>Add to subscriptions/u);
  assert.match(page, /action="\/users"[\s\S]*?<button type="submit" class="btn btn-primary" disabled>Create user/u);
  assert.match(page, /action="\/users\/user-one\/rotate-token"[\s\S]*?<button type="submit" class="btn btn-secondary" disabled>Rotate subscription token/u);
  assert.match(page, /action="\/users\/user-one\/rotate-credentials"[\s\S]*?<button type="submit" class="btn btn-secondary" disabled>Rotate UUID/u);
  assert.match(page, /action="\/users\/user-one\/reset-password"[\s\S]*?<button type="submit" class="btn btn-secondary" disabled>Reset portal password/u);
});

test('portal credentials appear only when issued and legacy users are flagged for a reset', () => {
  const issued = renderCredentialsCard({
    user: { id: 'user-one', displayName: 'Alice <b>' }, rawPassword: 'abcde-fghij-kmnop-<qrstu',
  }, { heading: 'Portal password reset', publicOrigin: 'https://admin.example.com' });
  assert.match(issued, /<h2 id="credentials-title">Portal password reset<\/h2>/u);
  assert.match(issued, /Sign-in name<\/dt><dd><pre class="copy">Alice &lt;b&gt;<\/pre>/u);
  assert.match(issued, /Portal password<\/dt><dd><pre class="copy">abcde-fghij-kmnop-&lt;qrstu<\/pre>/u);
  assert.match(issued, /Portal sign-in<\/dt><dd><pre class="copy">https:\/\/admin\.example\.com\/account\/login<\/pre>/u);
  assert.doesNotMatch(issued, /Raw subscription token|VLESS link/u);
  const rotated = renderCredentialsCard({ rawToken: 'token-only', vlessLink: 'vless://x' }, { heading: 'Subscription token rotated' });
  assert.doesNotMatch(rotated, /Portal password|Sign-in name|Portal sign-in/u);

  const page = renderUsersPage({
    revision: 1, csrf: 'csrf', ready: true,
    users: [
      { id: 'legacy', displayName: 'Legacy', status: 'active', hasPassword: false },
      { id: 'modern', displayName: 'Modern', status: 'disabled', hasPassword: true },
    ],
  });
  assert.match(page, /<h3>Legacy<\/h3>[\s\S]*?No portal password[\s\S]*?action="\/users\/legacy\/reset-password"[\s\S]*?>Set portal password</u);
  assert.match(page, /<h3>Modern<\/h3>[\s\S]*?action="\/users\/modern\/reset-password"[\s\S]*?>Reset portal password</u);
  assert.equal((page.match(/No portal password/gu) ?? []).length, 1);
  assert.doesNotMatch(page, /reset-password"[\s\S]*?name="operationId"[\s\S]*?<\/form>\n<form method="post" action="\/users\/legacy\/export/u);
});

test('published exits escape directory labels and preserve removal without a directory', () => {
  const page = renderAll({
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
  const page = renderAll({
    revision: 8,
    csrf: 'csrf',
    ready: true,
    exitDirectoryAvailable: true,
    exitNodes: [{ deviceId: 'exit-one', name: 'Available exit' }],
    selectableExits: Array.from({ length: 15 }, (_, index) => ({
      id: index.toString(16).padStart(16, '0'), name: `Exit ${index}`, address: '100.64.0.2',
    })),
  });
  assert.match(page, /action="\/exit-nodes"[\s\S]*?<button type="submit" class="btn btn-primary" disabled>Add to subscriptions/u);
  assert.equal([...page.matchAll(/<button type="submit" class="btn btn-danger-ghost">Remove from subscriptions/gu)].length, 15);
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
    const page = renderAll({ ...snapshot, gateway: { exitNode: defaultExit } });
    const addForm = page.match(/<form method="post" action="\/exit-nodes" class="form-row">[\s\S]*?<\/form>/u)?.[0];
    assert.ok(addForm);
    assert.deepEqual([...addForm.matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1]), ['new-device']);
    const defaultForm = page.match(/<form method="post" action="\/exit-node" class="form-row">[\s\S]*?<\/form>/u)?.[0];
    assert.deepEqual([...defaultForm.matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1]),
      nodes.map(({ deviceId }) => deviceId));
  }
  const fullyPublished = renderAll({ ...snapshot, exitNodes: nodes.slice(0, -1) });
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


test('unified portal displays a read-only subscription origin and uses the local origin for one-time links', () => {
  const publicOrigin = 'http://127.0.0.1:8081';
  const page = renderOverviewPage({
    gateway: { subscriptionPublicBaseUrl: 'https://admin.example.com' },
  }, { publicOrigin });
  assert.match(page, /Administration and subscriptions<\/dt><dd><code>http:\/\/127\.0\.0\.1:8081<\/code>/u);
  assert.doesNotMatch(page, /action="\/public-base"|name="url"/u);
  const result = { rawToken: 'local-token', subscriptionUrl: 'https://admin.example.com/s/local-token', rawPassword: 'local-password' };
  const secret = renderUsersPage({ revision: 1, csrf: 'csrf', users: [] }, {
    publicOrigin, credentials: { heading: 'User created', result },
  });
  assert.match(secret, /<h2 id="credentials-title">User created<\/h2>[\s\S]*local-token[\s\S]*action="\/users"/u);
  assert.match(secret, /http:\/\/127\.0\.0\.1:8081\/s\/local-token/u);
  assert.match(secret, /http:\/\/127\.0\.0\.1:8081\/account\/login/u);
  assert.match(page, /User portal<\/dt><dd><code>http:\/\/127\.0\.0\.1:8081\/account\/login<\/code>/u);
  assert.doesNotMatch(secret, /https:\/\/admin\.example\.com/u);
  assert.equal(result.subscriptionUrl, 'https://admin.example.com/s/local-token');
});

test('each administration page owns one section and marks itself in the navigation', () => {
  const snapshot = {
    revision: 2, csrf: 'csrf', ready: true, exitDirectoryAvailable: false,
    gateway: { vpnPublicHostname: 'vpn.example.com', publicPort: 443, adminPublicHostname: 'admin.example.com' },
    users: [{ id: 'user-one', displayName: 'Alice', status: 'active' }],
  };
  const overview = renderOverviewPage(snapshot);
  const exits = renderExitNodesPage(snapshot);
  const users = renderUsersPage(snapshot);
  for (const [page, href] of [[overview, '/overview'], [exits, '/exit-nodes'], [users, '/users']]) {
    assert.match(page, new RegExp(`<a href="${href}" aria-current="page">`, 'u'));
    assert.equal([...page.matchAll(/aria-current="page"/gu)].length, 1);
    assert.match(page, /<a href="\/overview"[^>]*>Overview<\/a>[\s\S]*<a href="\/exit-nodes"[^>]*>Exit nodes<\/a>[\s\S]*<a href="\/users"[^>]*>Users<\/a>/u);
  }
  assert.match(overview, /<title>Overview · VPN Gateway Admin<\/title>[\s\S]*Gateway overview/u);
  assert.doesNotMatch(overview, /action="\/users"|Default exit node|user-one/u);
  assert.match(exits, /<title>Exit nodes · VPN Gateway Admin<\/title>[\s\S]*Default exit node[\s\S]*Client-selectable exits/u);
  assert.doesNotMatch(exits, /action="\/users"|Gateway overview|user-one/u);
  assert.match(users, /<title>Users · VPN Gateway Admin<\/title>[\s\S]*action="\/users"[\s\S]*user-one/u);
  assert.doesNotMatch(users, /Gateway overview|Default exit node/u);
});

test('required fields use styled inline messages instead of native validation bubbles', () => {
  const snapshot = { revision: 2, csrf: 'csrf', users: [{ id: 'user-one', displayName: 'Alice', status: 'active' }] };
  const login = renderLoginPage({ csrf: 'csrf-token' });
  assert.match(login, /<form method="post" action="\/login" novalidate>/u);
  assert.match(login, /<span class="field-error" id="secret-error">Enter the administrator secret\.<\/span>/u);
  assert.doesNotMatch(login, /aria-invalid/u);
  assert.match(renderLoginPage({ csrf: 'csrf-token', missingSecret: true }), /name="secret"[^>]*aria-invalid="true"/u);
  const users = renderUsersPage(snapshot);
  assert.match(users, /<form method="post" action="\/users" class="form-row" novalidate>/u);
  assert.match(users, /<form method="post" action="\/users\/user-one\/revoke" novalidate>/u);
  assert.match(users, /<span class="field-error" id="display-name-error">Enter a display name\.<\/span>/u);
  assert.doesNotMatch(users, /aria-invalid|<details class="danger" open>/u);
  const createError = renderUsersPage(snapshot, { createError: 'This name is already in use.' });
  assert.match(createError, /name="displayName"[^>]*aria-invalid="true"/u);
  assert.match(createError, /id="display-name-error">This name is already in use\.</u);
  assert.doesNotMatch(createError, /name="confirmName"[^>]*aria-invalid/u);
  const revokeError = renderUsersPage(snapshot, { revokeError: 'user-one' });
  assert.match(revokeError, /<details class="danger" open>[\s\S]*name="confirmName"[^>]*aria-invalid="true"/u);
  assert.doesNotMatch(revokeError, /name="displayName"[^>]*aria-invalid/u);
  for (const page of [login, users, createError, revokeError]) assert.doesNotMatch(page, /<script/iu);
});

test('user rows offer inline renaming and show accumulated usage', () => {
  const snapshot = {
    revision: 3, csrf: 'csrf', ready: true,
    users: [
      { id: 'user-one', displayName: 'Alice <1>', status: 'active', usage: { uplinkBytes: 1500, downlinkBytes: 2_500_000_000, updatedAt: '2026-09-11T10:00:00.000Z' } },
      { id: 'user-two', displayName: 'Bob', status: 'disabled', usage: null },
      { id: 'user-three', displayName: 'Gone', status: 'revoked', usage: { uplinkBytes: 0, downlinkBytes: 42, updatedAt: '2026-09-01T00:00:00.000Z' } },
    ],
  };
  const page = renderUsersPage(snapshot);
  assert.match(page, /<form method="post" action="\/users\/user-one\/rename" class="form-row" novalidate>[\s\S]*?name="displayName"[^>]*value="Alice &lt;1&gt;"/u);
  assert.match(page, /<form method="post" action="\/users\/user-two\/rename"/u);
  assert.doesNotMatch(page, /action="\/users\/user-three\/rename"/u);
  assert.doesNotMatch(page, /<details class="rename" open>/u);
  assert.match(page, /&uarr; 1\.5 KB uploaded &middot; &darr; 2\.5 GB downloaded<\/span> &middot; updated 2026-09-11/u);
  assert.match(page, /Usage: no traffic recorded yet\./u);
  assert.match(page, /&uarr; 0 B uploaded &middot; &darr; 42 B downloaded/u);
  const renameError = renderUsersPage(snapshot, { renameError: { userId: 'user-two', message: 'This name is already in use.' } });
  assert.match(renameError, /action="\/users\/user-two\/rename"[\s\S]*?name="displayName"[^>]*aria-invalid="true"[\s\S]*?id="rename-user-two-error">This name is already in use\.</u);
  assert.match(renameError, /<details class="rename" open>/u);
  assert.equal([...renameError.matchAll(/<details class="rename" open>/gu)].length, 1);
  const degraded = renderUsersPage({ ...snapshot, ready: false });
  assert.match(degraded, /action="\/users\/user-one\/rename"[\s\S]*?name="displayName"[^>]*disabled>[\s\S]*?<button type="submit" class="btn btn-secondary" disabled>Save name/u);
});
