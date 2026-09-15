import { document, escapeHtml, fieldError, hidden } from './document.js';
import { authShell, brandMark } from './layout.js';

const CONTROLLER_ERROR_MESSAGES = new Map([
  ['ENROLLMENT_KEY_REQUIRED', 'Configure a Tailscale enrollment key before adding an exit'],
  ['ENROLLMENT_KEY_UNAVAILABLE', 'The Tailscale enrollment key is unavailable; check its configured secret file'],
  ['EXIT_ALREADY_PUBLISHED', 'This exit is already the default exit or published in subscriptions'],
  ['EXIT_LIMIT_REACHED', 'The limit of 15 additional exits has been reached; remove an exit before adding another'],
  ['EXIT_DIRECTORY_REQUIRED', 'Configure the Tailscale API credential to load the exit-node directory'],
  ['EXIT_DIRECTORY_UNAVAILABLE', 'The exit-node directory is unavailable; check the Tailscale API credential and network access'],
  ['RATE_LIMITED', 'Too many changes in a short time; try again later'],
]);

export function renderLoginPage({ csrf, error = false, missingSecret = false } = {}) {
  const notice = error
    ? '<p class="alert" role="alert">Sign-in failed. Check the administrator secret and try again.</p>'
    : '';
  return document('Administrator sign in · VPN Gateway Admin', authShell(`
<section class="card auth-card" aria-labelledby="login-title">
<h1 id="login-title" class="brand">${brandMark(28)}<span>VPN Gateway</span></h1>
${notice}
<form method="post" action="/login" novalidate>
${hidden('csrf', csrf)}
<label class="field"><span>Administrator secret</span>
<input name="secret" type="password" required maxlength="4096" autocomplete="current-password" autofocus placeholder="Administrator secret" aria-describedby="secret-error"${missingSecret ? ' aria-invalid="true"' : ''}>
${fieldError('secret-error', 'Enter the administrator secret.')}
</label>
<button type="submit" class="btn btn-primary btn-block">Sign in</button>
</form>
<p class="meta"><a href="/account/login">User sign-in</a></p>
</section>`));
}

export function renderErrorPage(status = 500, code = undefined, { home = '/' } = {}) {
  const message = CONTROLLER_ERROR_MESSAGES.get(code)
    ?? (status === 403 ? 'Request forbidden' : status === 409 ? 'State changed; reload and try again' : 'Request failed');
  const back = home === '/account'
    ? '<a class="btn btn-secondary" href="/account">Back to your account</a>'
    : '<a class="btn btn-secondary" href="/">Back to administration</a>';
  return document(`${message} · VPN Gateway`, authShell(`
<section class="card" aria-labelledby="error-title">
<h1 id="error-title">${escapeHtml(message)}</h1>
<p class="muted">The operation was not completed. If the problem persists, contact the administrator or check gateway health.</p>
<p class="actions">${back}</p>
</section>`));
}
