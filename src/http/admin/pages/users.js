import { escapeHtml, safeId, mutationFields, credentialMutationFields, hidden } from './document.js';

export function renderUser(snapshot, user) {
  const id = safeId(user?.id);
  if (!id) return '';
  const name = escapeHtml(user?.displayName ?? id);
  const status = user?.status === 'disabled' || user?.status === 'revoked' ? user.status : 'active';
  if (status === 'revoked') {
    return `<li>
<h3>${name}</h3>
<p>ID: <code>${escapeHtml(id)}</code>; status: <strong>revoked</strong></p>
</li>`;
  }
  const nextStatus = status === 'active' ? 'disabled' : 'active';
  const mutationDisabled = snapshot.ready === false ? ' disabled' : '';
  const credentialDisabled = snapshot.ready === false || status !== 'active' ? ' disabled' : '';
  const exportLink = status === 'active' ? `<p><a href="/users/${id}/export">Export VLESS link</a></p>` : '';
  const statusForm = `
<form method="post" action="/users/${id}/status">
${mutationFields(snapshot)}${hidden('status', nextStatus)}
<button type="submit"${mutationDisabled}>Mark ${escapeHtml(nextStatus)}</button>
</form>`;
  return `<li>
<h3>${name}</h3>
<p>ID: <code>${escapeHtml(id)}</code>; status: <strong>${escapeHtml(status)}</strong></p>
${statusForm}
<form method="post" action="/users/${id}/rotate-token">
${credentialMutationFields(snapshot)}
<button type="submit"${credentialDisabled}>Rotate subscription token</button>
</form>
<form method="post" action="/users/${id}/rotate-credentials">
${credentialMutationFields(snapshot)}
<button type="submit"${credentialDisabled}>Rotate UUID and subscription token</button>
</form>
<form method="post" action="/users/${id}/revoke">
${mutationFields(snapshot)}
<label>Type the display name to confirm <input name="confirmName" required maxlength="128" autocomplete="off"></label>
<button type="submit"${mutationDisabled}>Revoke permanently</button>
</form>
${exportLink}
</li>`;
}
