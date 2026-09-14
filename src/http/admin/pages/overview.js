import { escapeHtml, hostText } from './document.js';
import { readinessBadge } from './layout.js';

/** Gateway overview: addresses, data-path state, and fleet counters. */
export function renderOverview(snapshot = {}, { publicOrigin } = {}) {
  const gatewayHost = hostText(snapshot.gateway?.vpnPublicHostname);
  const gatewayPort = snapshot.gateway?.publicPort ?? '';
  const publicBase = publicOrigin ?? snapshot.gateway?.subscriptionPublicBaseUrl ?? '';
  const users = Array.isArray(snapshot.users) ? snapshot.users : [];
  const active = users.filter((user) => user?.status === 'active').length;
  const disabled = users.filter((user) => user?.status === 'disabled').length;
  const revoked = users.filter((user) => user?.status === 'revoked').length;
  const exits = Array.isArray(snapshot.selectableExits) ? snapshot.selectableExits.length : 0;
  return `<section class="card" aria-labelledby="overview-title">
<div class="card-head">
<h2 id="overview-title">Gateway overview</h2>
${readinessBadge(snapshot.ready !== false)}
</div>
<dl class="kv">
<div><dt>VPN address</dt><dd><code>${escapeHtml(gatewayHost)}${gatewayPort ? `:${escapeHtml(gatewayPort)}` : ''}</code></dd></div>
<div><dt>Administration and subscriptions</dt><dd><code>${escapeHtml(publicBase)}</code></dd></div>
<div><dt>Subscription path</dt><dd><code>/s/&lt;token&gt;</code></dd></div>
<div><dt>User portal</dt><dd><code>${escapeHtml(publicBase)}/account/login</code></dd></div>
<div><dt>Users</dt><dd>${active} active · ${disabled} disabled · ${revoked} revoked records</dd></div>
<div><dt>Published selectable exits</dt><dd>${exits} / 15</dd></div>
</dl>
</section>`;
}
