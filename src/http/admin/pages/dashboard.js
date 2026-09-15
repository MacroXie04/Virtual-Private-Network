import { document, credentialMutationFields, fieldError } from './document.js';
import { adminShell } from './layout.js';
import { renderOverview } from './overview.js';
import { renderCredentialsCard, renderUser } from './users.js';
import { renderExitNodes, renderSelectableExits } from './exits.js';

function renderCreateUserCard(snapshot, { createError = null } = {}) {
  const mutationDisabled = snapshot.ready === false ? ' disabled' : '';
  return `<section class="card" aria-labelledby="create-user-title">
<div class="card-head"><h2 id="create-user-title">Create user</h2></div>
<form method="post" action="/users" class="form-row" novalidate>
${credentialMutationFields(snapshot)}
<label class="field"><span>Display name</span>
<input name="displayName" type="text" required maxlength="128" autocomplete="off" aria-describedby="display-name-error"${createError ? ' aria-invalid="true"' : ''}${mutationDisabled}>
${fieldError('display-name-error', createError ?? 'Enter a display name.')}
</label>
<button type="submit" class="btn btn-primary"${mutationDisabled}>Create user</button>
</form>
${mutationDisabled ? '<p class="meta">The data path is unavailable; user creation is temporarily disabled.</p>' : ''}
</section>`;
}

function renderUserList(snapshot, { revokeError = null, renameError = null } = {}) {
  const users = Array.isArray(snapshot.users) ? snapshot.users : [];
  const revokedOmitted = Number.isSafeInteger(snapshot.revokedOmitted) && snapshot.revokedOmitted > 0
    ? `<p class="meta">${snapshot.revokedOmitted} older revoked records are retained in state but omitted here.</p>`
    : '';
  const list = users.length > 0
    ? `<ul class="user-list">${users.map((user) => renderUser(snapshot, user, { revokeError, renameError })).join('\n')}</ul>`
    : '<p class="empty">No users yet. Create the first user with the form above.</p>';
  return `<h2 class="section-title" id="user-list-title">User list</h2>
${revokedOmitted}
${list}`;
}

/** Overview page: gateway addresses, readiness and fleet counters. */
export function renderOverviewPage(snapshot = {}, { publicOrigin } = {}) {
  const content = renderOverview(snapshot, { publicOrigin });
  return document('Overview · VPN Gateway Admin', adminShell(snapshot, content, { current: 'overview' }));
}

/** Exit nodes page: default exit selection and client-selectable exits. */
export function renderExitNodesPage(snapshot = {}) {
  const content = `<section class="card" aria-labelledby="default-exit-title">
<div class="card-head"><h2 id="default-exit-title">Default exit node</h2></div>
${renderExitNodes(snapshot)}
</section>
<section class="card" aria-labelledby="selectable-exits-title">
<div class="card-head"><h2 id="selectable-exits-title">Client-selectable exits</h2></div>
${renderSelectableExits(snapshot)}
</section>`;
  return document('Exit nodes · VPN Gateway Admin', adminShell(snapshot, content, { current: 'exits' }));
}

/** Users page: one-time credentials from the last action, user creation and per-user controls. */
export function renderUsersPage(snapshot = {}, {
  publicOrigin, createError = null, revokeError = null, renameError = null, credentials = null,
} = {}) {
  const content = [
    credentials ? renderCredentialsCard(credentials.result, { heading: credentials.heading, publicOrigin }) : '',
    renderCreateUserCard(snapshot, { createError }),
    renderUserList(snapshot, { revokeError, renameError }),
  ].filter(Boolean).join('\n');
  return document('Users · VPN Gateway Admin', adminShell(snapshot, content, { current: 'users' }));
}
