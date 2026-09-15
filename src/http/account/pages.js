import { document, escapeHtml, fieldError, hidden } from '../admin/pages/document.js';
import { authShell, brandMark, readinessBadge } from '../admin/pages/layout.js';

/** End-user sign-in: display name and password, one generic failure message. */
export function renderAccountLoginPage({
  csrf, displayName = '', error = false, missingName = false, missingPassword = false,
} = {}) {
  const notice = error
    ? '<p class="alert" role="alert">Sign-in failed. Check your display name and password.</p>'
    : '';
  return document('Sign in · VPN Gateway', authShell(`
<section class="card auth-card" aria-labelledby="account-login-title">
<h1 id="account-login-title" class="brand">${brandMark(28)}<span>VPN Gateway</span></h1>
<p class="muted">Sign in with the display name and password your administrator gave you.</p>
${notice}
<form method="post" action="/account/login" novalidate>
${hidden('csrf', csrf)}
<label class="field"><span>Display name</span>
<input name="displayName" type="text" required maxlength="128" autocomplete="username" autofocus placeholder="Display name" value="${escapeHtml(displayName)}" aria-describedby="account-name-error"${missingName ? ' aria-invalid="true"' : ''}>
${fieldError('account-name-error', 'Enter your display name.')}
</label>
<label class="field"><span>Password</span>
<input name="password" type="password" required maxlength="1024" autocomplete="current-password" placeholder="Password" aria-describedby="account-password-error"${missingPassword ? ' aria-invalid="true"' : ''}>
${fieldError('account-password-error', 'Enter your password.')}
</label>
<button type="submit" class="btn btn-primary btn-block">Sign in</button>
</form>
</section>`));
}

/** Only the maintenance state is worth a banner for end users. */
export function accountReadinessBanner(ready) {
  if (ready !== false) return '';
  return '<p class="banner banner-warn" role="alert"><span>The gateway is in maintenance. Your existing connection details stay valid; generating a new link and changing your password are unavailable until it recovers.</span></p>';
}

/** Signed-in frame: brand, who is signed in, readiness and sign-out; no administration navigation. */
export function accountShell(snapshot, content) {
  const ready = snapshot.ready !== false;
  return `<a class="skip-link" href="#main">Skip to main content</a>
<header class="topbar">
<div class="topbar-inner">
<h1 class="brand">${brandMark()}<span>VPN Gateway</span></h1>
<p class="meta whoami">Signed in as <strong>${escapeHtml(snapshot.user?.displayName ?? '')}</strong></p>
${readinessBadge(ready)}
<form method="post" action="/account/logout" class="logout">
${hidden('csrf', snapshot.csrf)}
<button type="submit" class="btn btn-ghost">Sign out</button>
</form>
</div>
</header>
<main id="main" class="wrap">
${accountReadinessBanner(ready)}
${content}
</main>`;
}
