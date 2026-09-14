import { randomUUID } from 'node:crypto';
import { ADMIN_STYLES_PATH } from './styles.js';

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

export function document(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="${ADMIN_STYLES_PATH}">
<title>${escapeHtml(title)}</title>
</head>
<body>
${content}
</body>
</html>
`;
}

export function hidden(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

/** Inline field message; the stylesheet reveals it when the input is invalid or server-flagged. */
export function fieldError(id, message) {
  return `<span class="field-error" id="${escapeHtml(id)}">${escapeHtml(message)}</span>`;
}

export function mutationFields(snapshot) {
  return `${hidden('csrf', snapshot.csrf)}${hidden('expectedRevision', snapshot.revision)}`;
}

export function credentialMutationFields(snapshot) {
  return `${mutationFields(snapshot)}${hidden('operationId', randomUUID())}`;
}

/** Calendar date of an ISO timestamp, escaped; empty for anything unparsable. */
export function formatDate(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? escapeHtml(value.slice(0, 10)) : '';
}

/** Human-readable decimal byte counts for usage displays. */
export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : amount >= 100 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

export function safeId(value) {
  const id = String(value ?? '');
  return /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : '';
}

export function hostText(host) {
  if (host && typeof host === 'object' && typeof host.value === 'string') return host.value;
  return typeof host === 'string' ? host : '';
}
