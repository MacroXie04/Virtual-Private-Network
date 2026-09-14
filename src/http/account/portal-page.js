import { document, escapeHtml, fieldError, formatBytes, formatDate, hidden } from '../admin/pages/document.js';
import { accountShell } from './pages.js';

function secretRows(rows) {
  return rows
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd><pre class="copy">${escapeHtml(value)}</pre></dd></div>`)
    .join('\n');
}

/** One-time card after rotation; the origin rule matches the administrator card so local mode shows the local origin. */
function newLinkCard(credentials, publicOrigin) {
  if (!credentials || typeof credentials.rawToken !== 'string') return '';
  const base = publicOrigin
    ? `${publicOrigin}/s/${encodeURIComponent(credentials.rawToken)}`
    : credentials.subscriptionUrl ?? '';
  return `<section class="card" aria-labelledby="new-link-title">
<div class="card-head"><h2 id="new-link-title">New subscription link</h2></div>
<p class="alert" role="alert">Copy this link now. It is shown only once, and your previous subscription link stopped working the moment this one was generated.</p>
<dl class="secret-list">
${secretRows([
    ['Subscription URL', base],
    ['sing-box subscription', base ? `${base}/sing-box` : ''],
    ['Clash subscription', base ? `${base}/clash` : ''],
    ['Raw subscription token', credentials.rawToken],
    ['VLESS link (default exit)', credentials.vlessLink],
  ])}
</dl>
</section>`;
}

function connectionCard(snapshot) {
  const host = escapeHtml(snapshot.gateway?.vpnPublicHostname ?? '');
  const port = Number.isSafeInteger(snapshot.gateway?.publicPort) ? snapshot.gateway.publicPort : 443;
  const exits = Array.isArray(snapshot.exits) ? snapshot.exits : [];
  const connections = Array.isArray(snapshot.connections) ? snapshot.connections : [];
  const links = secretRows(connections.map((connection) => [connection?.name ?? '', connection?.link]));
  return `<section class="card" aria-labelledby="connection-title">
<div class="card-head"><h2 id="connection-title">Connection details</h2></div>
<dl class="kv">
<div><dt>Gateway</dt><dd><code>${host}:${port}</code></dd></div>
<div><dt>Transport</dt><dd>VLESS over WebSocket (TLS)</dd></div>
<div><dt>Published exits</dt><dd>${exits.length > 0 ? exits.map((exit) => escapeHtml(exit?.name ?? '')).join(', ') : 'Default only'}</dd></div>
</dl>
<h3 class="section-title">VLESS links</h3>
${links ? `<dl class="secret-list">\n${links}\n</dl>` : '<p class="empty">No connection is published for this account.</p>'}
<div class="actions">
<a class="btn btn-secondary" href="/account/downloads/sing-box">Download sing-box config</a>
<a class="btn btn-secondary" href="/account/downloads/clash">Download Clash config</a>
<a class="btn btn-secondary" href="/account/downloads/links">Download link list</a>
</div>
</section>`;
}

function usageCard(snapshot) {
  const usage = snapshot.usage;
  const body = usage && typeof usage === 'object'
    ? `<dl class="kv">
<div><dt>Uploaded</dt><dd class="usage">${escapeHtml(formatBytes(usage.uplinkBytes))}</dd></div>
<div><dt>Downloaded</dt><dd class="usage">${escapeHtml(formatBytes(usage.downlinkBytes))}</dd></div>
<div><dt>Updated</dt><dd>${formatDate(usage.updatedAt) || 'just now'}</dd></div>
</dl>`
    : '<p class="empty">No traffic recorded yet.</p>';
  return `<section class="card" aria-labelledby="usage-title">
<div class="card-head"><h2 id="usage-title">Usage</h2></div>
${body}
</section>`;
}

function subscriptionCard(snapshot) {
  const disabled = snapshot.ready === false ? ' disabled' : '';
  return `<section class="card" aria-labelledby="subscription-title">
<div class="card-head"><h2 id="subscription-title">Subscription link</h2></div>
<p class="muted">The gateway keeps only a fingerprint of your subscription link, so an existing link cannot be shown again. Generating a new one replaces the old link immediately; import the new link into your client afterwards.</p>
<form method="post" action="/account/rotate-token">
${hidden('csrf', snapshot.csrf)}
<button type="submit" class="btn btn-secondary"${disabled}>Generate new subscription link</button>
</form>
</section>`;
}

function passwordCard(snapshot, passwordError) {
  const disabled = snapshot.ready === false ? ' disabled' : '';
  const [flagged, message] = Array.isArray(passwordError) ? passwordError : [null, null];
  const input = (name, label, autocomplete, fallback) => `<label class="field"><span>${label}</span>
<input name="${name}" type="password" required${autocomplete === 'new-password' ? ' minlength="12"' : ''} maxlength="1024" autocomplete="${autocomplete}" aria-describedby="${name}-error"${flagged === name ? ' aria-invalid="true"' : ''}${disabled}>
${fieldError(`${name}-error`, flagged === name ? String(message) : fallback)}
</label>`;
  return `<section class="card" aria-labelledby="password-title">
<div class="card-head"><h2 id="password-title">Change password</h2></div>
<form method="post" action="/account/password" class="form-stack" novalidate>
${hidden('csrf', snapshot.csrf)}
${input('currentPassword', 'Current password', 'current-password', 'Enter your current password.')}
${input('newPassword', 'New password', 'new-password', 'Use at least 12 characters.')}
${input('confirmPassword', 'Confirm new password', 'new-password', 'Repeat the new password.')}
<p class="meta">At least 12 characters. Other signed-in devices are signed out after the change.</p>
<div><button type="submit" class="btn btn-primary"${disabled}>Change password</button></div>
</form>
</section>`;
}

/** The whole portal on one page; secrets appear only in POST responses, never in URLs. */
export function renderAccountPage(snapshot = {}, {
  publicOrigin, notice = null, credentials = null, passwordError = null,
} = {}) {
  const content = [
    notice ? `<p class="banner banner-ok" role="status"><span>${escapeHtml(notice)}</span></p>` : '',
    newLinkCard(credentials, publicOrigin),
    connectionCard(snapshot),
    usageCard(snapshot),
    subscriptionCard(snapshot),
    passwordCard(snapshot, passwordError),
  ].filter(Boolean).join('\n');
  return document('Your account · VPN Gateway', accountShell(snapshot, content));
}
