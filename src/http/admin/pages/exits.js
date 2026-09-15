import { exitProfileId } from '../../../core/identity/exit-profiles.js';
import { escapeHtml, safeId, mutationFields } from './document.js';

function exitOptions(snapshot, nodes, { excludeOccupied = false } = {}) {
  const exits = Array.isArray(snapshot.selectableExits) ? snapshot.selectableExits : [];
  const defaultExit = snapshot.gateway?.exitNode;
  const defaultId = defaultExit?.deviceId ?? snapshot.gateway?.exitNodeId;
  const publishedIds = new Set(exits.map((exit) => exit?.id));
  const occupiedValues = new Set([
    defaultExit?.address,
    defaultExit?.name,
    ...exits.flatMap((exit) => [exit?.address, exit?.name]),
  ].filter((value) => typeof value === 'string' && value.length > 0));
  return nodes.flatMap((node) => {
    const id = safeId(node?.deviceId ?? node?.id);
    if (!id) return [];
    if (excludeOccupied && (id === defaultId || publishedIds.has(exitProfileId(id))
      || [node?.address, node?.ipv4, node?.ipv6, node?.name, node?.hostname]
        .some((value) => occupiedValues.has(value)))) return [];
    const label = node?.name ?? node?.hostname ?? id;
    const selected = !excludeOccupied && (defaultId === id) ? ' selected' : '';
    return [`<option value="${escapeHtml(id)}"${selected}>${escapeHtml(label)}</option>`];
  }).join('\n');
}

/** Default routed exit selection; always repairable, even when degraded. */
export function renderExitNodes(snapshot) {
  const nodes = Array.isArray(snapshot.exitNodes) ? snapshot.exitNodes : [];
  const currentAddress = snapshot.gateway?.exitNode?.address ?? '';
  const current = currentAddress
    ? `<p class="meta">Current default exit address: <code>${escapeHtml(currentAddress)}</code></p>`
    : '';
  if (snapshot.exitDirectoryAvailable !== true) {
    return `${current}<p class="alert" role="alert">The validated exit-node directory is unavailable. Check the Tailscale API credential and network access.</p>`;
  }
  const options = exitOptions(snapshot, nodes);
  if (options === '') {
    return `${current}<p class="alert" role="alert">No authorized, enabled exit nodes are currently available.</p>`;
  }
  return `${current}<form method="post" action="/exit-node" class="form-row">
${mutationFields(snapshot)}
<label class="field"><span>Exit node</span>
<select name="deviceId" required>${options}</select></label>
<button type="submit" class="btn btn-primary">Select exit node</button>
</form>`;
}

/** Additional exits published into subscriptions for client-side selection. */
export function renderSelectableExits(snapshot) {
  const exits = Array.isArray(snapshot.selectableExits) ? snapshot.selectableExits : [];
  const published = exits.flatMap((exit) => {
    if (typeof exit?.id !== 'string' || !/^[0-9a-f]{16}$/u.test(exit.id)) return [];
    return [`<li class="exit-item">
<p><strong>${escapeHtml(exit.name)}</strong> <code>${escapeHtml(exit.address)}</code></p>
<form method="post" action="/exit-nodes/${exit.id}/remove">
${mutationFields(snapshot)}
<button type="submit" class="btn btn-danger-ghost">Remove from subscriptions</button>
</form>
</li>`];
  }).join('\n');
  const nodes = Array.isArray(snapshot.exitNodes) ? snapshot.exitNodes : [];
  const options = exitOptions(snapshot, nodes, { excludeOccupied: true });
  const disabled = snapshot.ready === false || exits.length >= 15 ? ' disabled' : '';
  const limitNote = exits.length >= 15
    ? '<p class="meta">The limit of 15 additional exits has been reached; remove an exit before adding another.</p>'
    : '';
  const addForm = snapshot.exitDirectoryAvailable === true && options !== ''
    ? `<form method="post" action="/exit-nodes" class="form-row">
${mutationFields(snapshot)}
<label class="field"><span>Exit node</span>
<select name="deviceId" required${disabled}>${options}</select></label>
<button type="submit" class="btn btn-primary"${disabled}>Add to subscriptions</button>
</form>`
    : snapshot.exitDirectoryAvailable === true
      ? '<p class="empty">No additional exit nodes are available to add.</p>'
      : '<p class="empty">Adding an exit requires an available validated Tailscale exit-node directory.</p>';
  return `<p class="muted">After refreshing their subscription, every user can choose the default exit and the published exits below in their VPN client. Up to 15 additional exits can be published.</p>
${published ? `<ul class="exit-list">${published}</ul>` : '<p class="empty">No additional exits are published.</p>'}
${limitNote}
${addForm}
<p class="meta">Adding or removing an exit briefly restarts the gateway. Removing an exit disconnects its profiles; refresh subscriptions afterward.</p>`;
}
