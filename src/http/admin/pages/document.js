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

export function document(title, content) {
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

export function hidden(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

export function mutationFields(snapshot) {
  return `${hidden('csrf', snapshot.csrf)}${hidden('expectedRevision', snapshot.revision)}`;
}

export function credentialMutationFields(snapshot) {
  return `${mutationFields(snapshot)}${hidden('operationId', randomUUID())}`;
}

export function safeId(value) {
  const id = String(value ?? '');
  return /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : '';
}

export function hostText(host) {
  if (host && typeof host === 'object' && typeof host.value === 'string') return host.value;
  return typeof host === 'string' ? host : '';
}
