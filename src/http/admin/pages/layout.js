import { escapeHtml, hidden } from './document.js';

const ICON_LOGO = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.5 9.3-8 11-4.5-1.7-8-6-8-11V5l8-3z" fill="#e8effc" stroke="#1d4ed8" stroke-width="1.8"/><path d="M8.4 12.1l2.4 2.4 4.8-5" fill="none" stroke="#1d4ed8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.4l2.6 2.6L16.2 9.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.5L22 20H2L12 3.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/></svg>';

const BADGE_KINDS = new Set(['ok', 'warn', 'off', 'revoked']);
const NAV_ITEMS = Object.freeze([
  ['overview', '/overview', 'Overview'],
  ['exits', '/exit-nodes', 'Exit nodes'],
  ['users', '/users', 'Users'],
]);

/** Status badge; text is always escaped, kind is whitelisted. */
export function badge(kind, text) {
  const safeKind = BADGE_KINDS.has(kind) ? kind : 'off';
  return `<span class="badge badge-${safeKind}">${escapeHtml(text)}</span>`;
}

export function readinessBadge(ready) {
  return ready === false ? badge('warn', 'Maintenance mode') : badge('ok', 'Ready');
}

/** Readiness banner describing the actual routed data-path state. */
export function readinessBanner(ready) {
  if (ready !== false) {
    return `<p class="banner banner-ok" role="status">${ICON_OK}<span>The routed VPN data path is ready; subscriptions and gateway changes are available.</span></p>`;
  }
  return `<p class="banner banner-warn" role="alert">${ICON_WARN}<span>The VPN data path is unavailable and public subscriptions are in maintenance mode. Select a working default exit or remove an unavailable published exit on the Exit nodes page; other changes are disabled until routed readiness succeeds.</span></p>`;
}

function navigation(current) {
  return NAV_ITEMS.map(([key, href, label]) => (
    `<a href="${href}"${key === current ? ' aria-current="page"' : ''}>${label}</a>`
  )).join('\n');
}

/** Authenticated page frame: top bar, page navigation, sign-out. */
export function adminShell(snapshot, content, { current = 'overview' } = {}) {
  const ready = snapshot.ready !== false;
  return `<a class="skip-link" href="#main">Skip to main content</a>
<header class="topbar">
<div class="topbar-inner">
<h1 class="brand">${ICON_LOGO}<span>VPN Gateway Admin</span></h1>
<nav class="nav" aria-label="Pages">
${navigation(current)}
</nav>
${readinessBadge(ready)}
<form method="post" action="/logout" class="logout">
${hidden('csrf', snapshot.csrf)}
<button type="submit" class="btn btn-ghost">Sign out</button>
</form>
</div>
</header>
<main id="main" class="wrap">
${readinessBanner(ready)}
${content}
</main>`;
}

/** Standalone centered frame for login, one-time credential, error and home pages. */
export function authShell(content, { wide = false } = {}) {
  return `<main class="auth-wrap">
<div class="auth-inner${wide ? ' auth-inner-wide' : ''}">
${content}
</div>
</main>`;
}

export function brandMark(size = 22) {
  return ICON_LOGO.replace('width="22" height="22"', `width="${size}" height="${size}"`);
}
