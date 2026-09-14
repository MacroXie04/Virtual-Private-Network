import { escapeHtml, formatBytes, formatDate, safeId, mutationFields, credentialMutationFields, fieldError, hidden } from './document.js';
import { badge } from './layout.js';

const STATUS_LABELS = { active: 'Active', disabled: 'Disabled', revoked: 'Revoked' };
const STATUS_BADGES = { active: 'ok', disabled: 'off', revoked: 'revoked' };

function statusBadge(status) {
  return badge(STATUS_BADGES[status] ?? 'off', STATUS_LABELS[status] ?? status);
}

function userMeta(user, id, status) {
  const parts = [`ID: <code>${escapeHtml(id)}</code>`];
  const created = formatDate(user?.createdAt);
  if (created) parts.push(`created ${created}`);
  if (status === 'disabled') {
    const disabledAt = formatDate(user?.disabledAt);
    if (disabledAt) parts.push(`disabled ${disabledAt}`);
  }
  if (status === 'revoked') {
    const revokedAt = formatDate(user?.revokedAt);
    if (revokedAt) parts.push(`revoked ${revokedAt}`);
  }
  return `<p class="meta">${parts.join(' · ')}</p>`;
}

function usageMeta(user) {
  const usage = user?.usage;
  if (!usage || typeof usage !== 'object') return '<p class="meta">Usage: no traffic recorded yet.</p>';
  const updated = formatDate(usage.updatedAt);
  return `<p class="meta">Usage: <span class="usage">&uarr; ${escapeHtml(formatBytes(usage.uplinkBytes))} uploaded &middot; &darr; ${escapeHtml(formatBytes(usage.downlinkBytes))} downloaded</span>${updated ? ` &middot; updated ${updated}` : ''}</p>`;
}

function renderRevokedRow(user, id, name) {
  return `<li class="user-row">
<div class="user-main">
<div class="user-identity"><h3>${name}</h3>${statusBadge('revoked')}${userMeta(user, id, 'revoked')}</div>
${usageMeta(user)}
<p class="meta">This user has been permanently revoked; subscriptions and connections are no longer valid.</p>
</div>
</li>`;
}

function renderActiveControls(snapshot, user, id, status) {
  const nextStatus = status === 'active' ? 'disabled' : 'active';
  const nextLabel = nextStatus === 'disabled' ? 'Disable' : 'Enable';
  const passwordLabel = user?.hasPassword === false ? 'Set portal password' : 'Reset portal password';
  const mutationDisabled = snapshot.ready === false ? ' disabled' : '';
  const credentialDisabled = snapshot.ready === false || status !== 'active' ? ' disabled' : '';
  const exportLink = status === 'active'
    ? `<a class="btn btn-secondary" href="/users/${id}/export">Export VLESS link</a>`
    : '';
  return `<div class="actions">
<form method="post" action="/users/${id}/status">
${mutationFields(snapshot)}${hidden('status', nextStatus)}
<button type="submit" class="btn btn-secondary"${mutationDisabled}>${nextLabel}</button>
</form>
<form method="post" action="/users/${id}/rotate-token">
${credentialMutationFields(snapshot)}
<button type="submit" class="btn btn-secondary"${credentialDisabled}>Rotate subscription token</button>
</form>
<form method="post" action="/users/${id}/rotate-credentials">
${credentialMutationFields(snapshot)}
<button type="submit" class="btn btn-secondary"${credentialDisabled}>Rotate UUID and subscription token</button>
</form>
<form method="post" action="/users/${id}/reset-password">
${mutationFields(snapshot)}
<button type="submit" class="btn btn-secondary"${mutationDisabled}>${passwordLabel}</button>
</form>
${exportLink}
</div>`;
}

function renderRenameZone(snapshot, id, name, message = null) {
  const mutationDisabled = snapshot.ready === false ? ' disabled' : '';
  const invalid = message !== null;
  return `<details class="rename"${invalid ? ' open' : ''}>
<summary>Rename user</summary>
<form method="post" action="/users/${id}/rename" class="form-row" novalidate>
${mutationFields(snapshot)}
<label class="field"><span>Display name</span>
<input name="displayName" type="text" required maxlength="128" autocomplete="off" value="${name}" aria-describedby="rename-${id}-error"${invalid ? ' aria-invalid="true"' : ''}${mutationDisabled}>
${fieldError(`rename-${id}-error`, message ?? 'Enter a display name.')}
</label>
<button type="submit" class="btn btn-secondary"${mutationDisabled}>Save name</button>
</form>
</details>`;
}

function renderRevokeZone(snapshot, user, id, name, invalid = false) {
  const mutationDisabled = snapshot.ready === false ? ' disabled' : '';
  return `<details class="danger"${invalid ? ' open' : ''}>
<summary>Danger zone</summary>
<form method="post" action="/users/${id}/revoke" novalidate>
${mutationFields(snapshot)}
<label class="field"><span>Type the display name &ldquo;${name}&rdquo; to confirm revocation</span>
<input name="confirmName" type="text" required maxlength="128" autocomplete="off" aria-describedby="confirm-${id}-error"${invalid ? ' aria-invalid="true"' : ''}${mutationDisabled}>
${fieldError(`confirm-${id}-error`, 'Type the display name exactly as shown.')}
</label>
<p class="hint">Revocation is permanent; the user&rsquo;s subscription and all connections stop working immediately.</p>
<div><button type="submit" class="btn btn-danger"${mutationDisabled}>Revoke permanently</button></div>
</form>
</details>`;
}

/** One-time credentials from create/rotate/reset, shown on the users page so they never enter a URL. */
export function renderCredentialsCard(result = {}, { heading = 'Credentials created', publicOrigin } = {}) {
  const subscription = publicOrigin && result.rawToken
    ? `${publicOrigin}/s/${encodeURIComponent(result.rawToken)}`
    : result.subscriptionUrl ?? '';
  const userName = result.user?.displayName ?? result.user?.id;
  const password = typeof result.rawPassword === 'string' ? result.rawPassword : null;
  // The portal address comes from this site's origin, never from the controller.
  const portal = password !== null && publicOrigin ? `${publicOrigin}/account/login` : '';
  return `<section class="card" aria-labelledby="credentials-title">
<div class="card-head"><h2 id="credentials-title">${escapeHtml(heading)}</h2></div>
${userName ? `<p class="meta">User: <strong>${escapeHtml(userName)}</strong></p>` : ''}
<p class="alert" role="alert">Copy and store these credentials now. They are shown only once and are never persisted.</p>
<dl class="secret-list">
${result.rawToken ? `<div><dt>Raw subscription token</dt><dd><pre class="copy">${escapeHtml(result.rawToken)}</pre></dd></div>` : ''}
${result.vlessLink ? `<div><dt>VLESS link</dt><dd><pre class="copy">${escapeHtml(result.vlessLink)}</pre></dd></div>` : ''}
${subscription ? `<div><dt>Subscription URL</dt><dd><pre class="copy">${escapeHtml(subscription)}</pre></dd></div>` : ''}
${password !== null ? `<div><dt>Sign-in name</dt><dd><pre class="copy">${escapeHtml(result.user?.displayName ?? '')}</pre></dd></div>` : ''}
${password !== null ? `<div><dt>Portal password</dt><dd><pre class="copy">${escapeHtml(password)}</pre></dd></div>` : ''}
${portal ? `<div><dt>Portal sign-in</dt><dd><pre class="copy">${escapeHtml(portal)}</pre></dd></div>` : ''}
</dl>
${subscription ? '<p class="muted">Import the subscription URL to choose among published exits in the client; the standalone VLESS link always uses the default exit.</p>' : ''}
</section>`;
}

export function renderUser(snapshot, user, { revokeError = null, renameError = null } = {}) {
  const id = safeId(user?.id);
  if (!id) return '';
  const name = escapeHtml(user?.displayName ?? id);
  const status = user?.status === 'disabled' || user?.status === 'revoked' ? user.status : 'active';
  if (status === 'revoked') return renderRevokedRow(user, id, name);
  return `<li class="user-row">
<div class="user-main">
<div class="user-identity"><h3>${name}</h3>${statusBadge(status)}${user?.hasPassword === false ? badge('warn', 'No portal password') : ''}${userMeta(user, id, status)}</div>
${usageMeta(user)}
</div>
${renderActiveControls(snapshot, user, id, status)}
${renderRenameZone(snapshot, id, name, renameError?.userId === id ? String(renameError.message) : null)}
${renderRevokeZone(snapshot, user, id, name, revokeError === id)}
</li>`;
}
