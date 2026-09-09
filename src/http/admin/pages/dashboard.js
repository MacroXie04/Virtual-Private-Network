import { document, escapeHtml, hostText, hidden, mutationFields, credentialMutationFields } from './document.js';
import { renderUser } from './users.js';
import { renderExitNodes, renderSelectableExits } from './exits.js';

/** Render the authenticated, script-free administration page. */
export function renderDashboardPage(snapshot = {}) {
  const users = Array.isArray(snapshot.users) ? snapshot.users : [];
  const gatewayHost = hostText(snapshot.gateway?.vpnPublicHostname);
  const gatewayPort = snapshot.gateway?.publicPort ?? '';
  const publicBase = snapshot.gateway?.subscriptionPublicBaseUrl ?? '';
  const adminHost = hostText(snapshot.gateway?.adminPublicHostname);
  const revokedOmitted = Number.isSafeInteger(snapshot.revokedOmitted) && snapshot.revokedOmitted > 0
    ? `<p>${escapeHtml(snapshot.revokedOmitted)} older revoked records are retained in state but omitted here.</p>`
    : '';
  const ready = snapshot.ready !== false;
  const mutationDisabled = ready ? '' : ' disabled';
  const runtimeNotice = ready
    ? '<p role="status">The routed VPN data path is ready.</p>'
    : '<p role="alert">The VPN data path is unavailable and public subscriptions are in maintenance mode. Select a working default exit or remove an unavailable published exit below; other changes are disabled until routed readiness succeeds.</p>';
  return document('VPN gateway administration', `
<h1>VPN gateway administration</h1>
${runtimeNotice}
<form method="post" action="/logout">
${hidden('csrf', snapshot.csrf)}
<button type="submit">Sign out</button>
</form>
<section>
<h2>Gateway</h2>
<p>VPN: <code>${escapeHtml(gatewayHost)}${gatewayPort ? `:${escapeHtml(gatewayPort)}` : ''}</code></p>
<p>Administration: <code>${escapeHtml(adminHost)}</code></p>
<form method="post" action="/public-base">
${mutationFields(snapshot)}
<label>Public subscription base URL <input name="url" type="url" required maxlength="2048" value="${escapeHtml(publicBase)}" placeholder="https://subscriptions.example"></label>
<button type="submit"${mutationDisabled}>Save public URL</button>
</form>
</section>
<section>
<h2>Default exit node</h2>
${renderExitNodes(snapshot)}
</section>
<section>
<h2>Client-selectable exits</h2>
${renderSelectableExits(snapshot)}
</section>
<section>
<h2>Create user</h2>
<form method="post" action="/users">
${credentialMutationFields(snapshot)}
<label>Display name <input name="displayName" required maxlength="128" autocomplete="off"></label>
<button type="submit"${mutationDisabled}>Create user</button>
</form>
</section>
<section>
<h2>Users</h2>
${revokedOmitted}
<ul>
${users.map((user) => renderUser(snapshot, user)).join('\n')}
</ul>
</section>`);
}
