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
<p class="meta"><a href="/">Home</a> · <a href="/account/login">User sign-in</a></p>
</section>`));
}

export function renderErrorPage(status = 500, code = undefined, { home = '/' } = {}) {
  const message = CONTROLLER_ERROR_MESSAGES.get(code)
    ?? (status === 403 ? 'Request forbidden' : status === 409 ? 'State changed; reload and try again' : 'Request failed');
  const back = home === '/account'
    ? '<a class="btn btn-secondary" href="/account">Back to your account</a>'
    : '<a class="btn btn-secondary" href="/overview">Back to administration</a>';
  return document(`${message} · VPN Gateway`, authShell(`
<section class="card" aria-labelledby="error-title">
<h1 id="error-title">${escapeHtml(message)}</h1>
<p class="muted">The operation was not completed. If the problem persists, contact the administrator or check gateway health.</p>
<p class="actions">${back}</p>
</section>`));
}

/**
 * Public front door, served for every GET of the site root regardless of cookies.
 * It takes no arguments on purpose: nothing on it comes from the controller or the
 * request, so there is nothing to escape and nothing to leak. A future dynamic value
 * must go through escapeHtml and must never make this page depend on a session or a
 * controller call. Its links go to each realm's landing page, which redirects to the
 * matching sign-in when no session is presented.
 */
export function renderHomePage() {
  return document('VPN Gateway', authShell(`
<section class="card home-hero" aria-labelledby="home-title">
<h1 id="home-title" class="brand">${brandMark(32)}<span>VPN Gateway</span></h1>
<p class="muted">A private VPN gateway for invited users. Your administrator gives you a display name, a password and a subscription link; sign in to see your connection details, download client files and manage your account.</p>
<p class="actions"><a class="btn btn-primary btn-block" href="/account">Sign in to your account</a></p>
</section>
<section class="card" aria-labelledby="connect-title">
<div class="card-head"><h2 id="connect-title">How to connect</h2></div>
<ol class="steps">
<li>Import the subscription link your administrator gave you into your VPN client.</li>
<li>If your client cannot import a link, sign in with the display name and password you were given and download a ready-made configuration file from your account page.</li>
<li>If more than one exit is published, choose one in your client. You can switch at any time without contacting the administrator.</li>
</ol>
</section>
<section class="card" aria-labelledby="help-title">
<div class="card-head"><h2 id="help-title">Need help?</h2></div>
<p>Forgot your password? Only your administrator can reset it.</p>
<p>Lost your subscription link? Sign in and generate a new one; the previous link stops working immediately.</p>
<p>If your client cannot refresh its subscription, the gateway may be in maintenance. Your existing connection details stay valid; try again later.</p>
<p class="muted">The gateway records each account's total upload and download volume; you can see yours after signing in.</p>
</section>
<p class="meta"><a href="/overview">Administration</a></p>`, { wide: true }));
}
