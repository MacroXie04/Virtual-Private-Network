import { randomUUID } from 'node:crypto';

/** Escape untrusted controller/state values for HTML text and attributes. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function document(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main>
${content}
</main>
</body>
</html>
`;
}

function hidden(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function mutationFields(snapshot) {
  return `${hidden('csrf', snapshot.csrf)}${hidden('expectedRevision', snapshot.revision)}`;
}

function credentialMutationFields(snapshot) {
  return `${mutationFields(snapshot)}${hidden('operationId', randomUUID())}`;
}

function safeId(value) {
  const id = String(value ?? '');
  return /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : '';
}

function hostText(host) {
  if (host && typeof host === 'object' && typeof host.value === 'string') return host.value;
  return typeof host === 'string' ? host : '';
}

export function renderLoginPage({ csrf, error = false } = {}) {
  const notice = error ? '<p role="alert">Sign-in failed.</p>' : '';
  return document('VPN gateway sign in', `
<h1>VPN gateway</h1>
${notice}
<form method="post" action="/login">
${hidden('csrf', csrf)}
<p><label>Administrator secret <input name="secret" type="password" required maxlength="4096" autocomplete="current-password"></label></p>
<p><button type="submit">Sign in</button></p>
</form>`);
}

function renderUser(snapshot, user) {
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

function renderExitNodes(snapshot) {
  const nodes = Array.isArray(snapshot.exitNodes) ? snapshot.exitNodes : [];
  const options = nodes.flatMap((node) => {
    const id = safeId(node?.deviceId ?? node?.id);
    if (!id) return [];
    const label = node?.name ?? node?.hostname ?? id;
    const selectedId = snapshot.gateway?.exitNode?.deviceId ?? snapshot.gateway?.exitNodeId;
    return [`<option value="${escapeHtml(id)}"${selectedId === id ? ' selected' : ''}>${escapeHtml(label)}</option>`];
  }).join('\n');
  if (snapshot.exitDirectoryAvailable !== true) {
    return '<p role="alert">The validated exit-node directory is unavailable. Check the Tailscale API credential and network access.</p>';
  }
  if (options === '') {
    return '<p role="alert">No authorized, enabled exit nodes are currently available.</p>';
  }
  return `<form method="post" action="/exit-node">
${mutationFields(snapshot)}
<label>Exit node <select name="deviceId" required>${options}</select></label>
<button type="submit">Select exit node</button>
</form>`;
}

/** Render the authenticated, script-free administration page. */
export function renderDashboardPage(snapshot = {}) {
  const users = Array.isArray(snapshot.users) ? snapshot.users : [];
  const gatewayHost = hostText(snapshot.gateway?.host);
  const gatewayPort = snapshot.gateway?.advertisedPort ?? '';
  const publicBase = snapshot.gateway?.publicBaseUrl ?? snapshot.publicBaseUrl ?? '';
  const revokedOmitted = Number.isSafeInteger(snapshot.revokedOmitted) && snapshot.revokedOmitted > 0
    ? `<p>${escapeHtml(snapshot.revokedOmitted)} older revoked records are retained in state but omitted here.</p>`
    : '';
  const ready = snapshot.ready !== false;
  const mutationDisabled = ready ? '' : ' disabled';
  const runtimeNotice = ready
    ? '<p role="status">The routed VPN data path is ready.</p>'
    : '<p role="alert">The VPN data path is unavailable and public subscriptions are in maintenance mode. Select a working exit node below; other changes are disabled until routed readiness succeeds.</p>';
  return document('VPN gateway administration', `
<h1>VPN gateway administration</h1>
${runtimeNotice}
<form method="post" action="/logout">
${hidden('csrf', snapshot.csrf)}
<button type="submit">Sign out</button>
</form>
<section>
<h2>Gateway</h2>
<p><code>${escapeHtml(gatewayHost)}${gatewayPort ? `:${escapeHtml(gatewayPort)}` : ''}</code></p>
<form method="post" action="/public-base">
${mutationFields(snapshot)}
<label>Public subscription base URL <input name="url" type="url" maxlength="2048" value="${escapeHtml(publicBase)}" placeholder="https://subscriptions.example"></label>
<button type="submit"${mutationDisabled}>Save public URL</button>
</form>
</section>
<section>
<h2>Exit node</h2>
${renderExitNodes(snapshot)}
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

/** Render secrets returned once by create/rotate without putting them in a URL. */
export function renderSecretPage(result = {}, { heading = 'Credentials created' } = {}) {
  const subscription = result.subscriptionUrl ?? result.subscriptionURL ?? '';
  return document(heading, `
<h1>${escapeHtml(heading)}</h1>
<p>Copy these values now. The raw subscription token is not persisted; only an exact retry of this request can recover it briefly.</p>
${result.rawToken ? `<h2>Raw subscription token</h2><pre>${escapeHtml(result.rawToken)}</pre>` : ''}
${result.vlessLink ? `<h2>VLESS link</h2><pre>${escapeHtml(result.vlessLink)}</pre>` : ''}
${subscription ? `<h2>Subscription URL</h2><pre>${escapeHtml(subscription)}</pre>` : ''}
<p><a href="/">Return to administration</a></p>`);
}

export function renderErrorPage(status = 500) {
  const message = status === 403 ? 'Request forbidden' : status === 409 ? 'State changed; reload and try again' : 'Request failed';
  return document(message, `<h1>${escapeHtml(message)}</h1><p><a href="/">Return to administration</a></p>`);
}
