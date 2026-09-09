import { exitProfileId } from '../../../core/identity/exit-profiles.js';
import { escapeHtml, safeId, mutationFields } from './document.js';

export function renderExitNodes(snapshot) {
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

export function renderSelectableExits(snapshot) {
  const exits = Array.isArray(snapshot.selectableExits) ? snapshot.selectableExits : [];
  const published = exits.flatMap((exit) => {
    if (typeof exit?.id !== 'string' || !/^[0-9a-f]{16}$/u.test(exit.id)) return [];
    return [`<li>
<p><strong>${escapeHtml(exit.name)}</strong> <code>${escapeHtml(exit.address)}</code></p>
<form method="post" action="/exit-nodes/${exit.id}/remove">
${mutationFields(snapshot)}
<button type="submit">Remove from subscriptions</button>
</form>
</li>`];
  }).join('\n');
  const nodes = Array.isArray(snapshot.exitNodes) ? snapshot.exitNodes : [];
  const defaultExit = snapshot.gateway?.exitNode;
  const defaultId = defaultExit?.deviceId ?? snapshot.gateway?.exitNodeId;
  const publishedIds = new Set(exits.map((exit) => exit?.id));
  const occupiedValues = new Set([
    defaultExit?.address,
    defaultExit?.name,
    ...exits.flatMap((exit) => [exit?.address, exit?.name]),
  ].filter((value) => typeof value === 'string' && value.length > 0));
  const options = nodes.flatMap((node) => {
    const id = safeId(node?.deviceId ?? node?.id);
    if (!id || id === defaultId || publishedIds.has(exitProfileId(id))
      || [node?.address, node?.ipv4, node?.ipv6, node?.name, node?.hostname]
        .some((value) => occupiedValues.has(value))) return [];
    return [`<option value="${escapeHtml(id)}">${escapeHtml(node?.name ?? node?.hostname ?? id)}</option>`];
  }).join('\n');
  const disabled = snapshot.ready === false || exits.length >= 15 ? ' disabled' : '';
  const addForm = snapshot.exitDirectoryAvailable === true && options !== ''
    ? `<form method="post" action="/exit-nodes">
${mutationFields(snapshot)}
<label>Exit node <select name="deviceId" required${disabled}>${options}</select></label>
<button type="submit"${disabled}>Add to subscriptions</button>
</form>`
    : snapshot.exitDirectoryAvailable === true
      ? '<p>No additional exit nodes are available to add.</p>'
      : '<p>Adding an exit requires an available validated Tailscale exit-node directory.</p>';
  return `<p>All users can choose the default exit and these published exits in their VPN client after refreshing their subscription. Up to 15 additional exits can be published.</p>
${published ? `<ul>${published}</ul>` : '<p>No additional exits are published.</p>'}
${addForm}
<p>Adding or removing an exit briefly restarts the gateway. Removing an exit disconnects its profiles; refresh subscriptions afterward.</p>`;
}
