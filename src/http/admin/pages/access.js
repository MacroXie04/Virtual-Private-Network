import { document, escapeHtml, hidden } from './document.js';

const CONTROLLER_ERROR_MESSAGES = new Map([
  ['ENROLLMENT_KEY_REQUIRED', 'Configure a Tailscale enrollment key before adding an exit'],
  ['ENROLLMENT_KEY_UNAVAILABLE', 'The Tailscale enrollment key is unavailable; check its configured secret file'],
  ['EXIT_ALREADY_PUBLISHED', 'This exit is already the default exit or published in subscriptions'],
  ['EXIT_LIMIT_REACHED', 'The limit of 15 additional exits has been reached; remove an exit before adding another'],
  ['EXIT_DIRECTORY_REQUIRED', 'Configure the Tailscale API credential to load the exit-node directory'],
  ['EXIT_DIRECTORY_UNAVAILABLE', 'The exit-node directory is unavailable; check the Tailscale API credential and network access'],
]);

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

/** Render secrets returned once by create/rotate without putting them in a URL. */
export function renderSecretPage(result = {}, { heading = 'Credentials created' } = {}) {
  const subscription = result.subscriptionUrl ?? result.subscriptionURL ?? '';
  return document(heading, `
<h1>${escapeHtml(heading)}</h1>
<p>Copy these values now. The raw subscription token is not persisted; only an exact retry of this request can recover it briefly.</p>
${result.rawToken ? `<h2>Raw subscription token</h2><pre>${escapeHtml(result.rawToken)}</pre>` : ''}
${result.vlessLink ? `<h2>VLESS link</h2><pre>${escapeHtml(result.vlessLink)}</pre>` : ''}
${subscription ? `<h2>Subscription URL</h2><pre>${escapeHtml(subscription)}</pre><p>Import this subscription to choose among published exits. The single VLESS link uses the default exit.</p>` : ''}
<p><a href="/">Return to administration</a></p>`);
}

export function renderErrorPage(status = 500, code = undefined) {
  const message = CONTROLLER_ERROR_MESSAGES.get(code)
    ?? (status === 403 ? 'Request forbidden' : status === 409 ? 'State changed; reload and try again' : 'Request failed');
  return document(message, `<h1>${escapeHtml(message)}</h1><p><a href="/">Return to administration</a></p>`);
}
