import { validateState } from '../core/state-schema.js';
import { renderVlessLink } from '../core/client-subscriptions.js';
import { ControllerError } from './request-contract.js';

export function safeUser(user) {
  return {
    id: user.id,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    disabledAt: user.disabledAt,
    revokedAt: user.revokedAt,
  };
}

export function nextState(value, patch, timestamp) {
  const state = validateState(value);
  return validateState({
    ...state,
    ...patch,
    revision: state.revision + 1,
    updatedAt: timestamp,
  });
}

export function hasEnrollmentCredentials(state) {
  return state.tailscale.authKey !== null
    || state.tailscale.apiKey !== null
    || (state.tailscale.extraExits ?? []).some((exit) => exit.authKey !== null);
}

export function credentialResult(controller, state, user, token, csrf) {
  const base = state.gateway.subscriptionPublicBaseUrl;
  return {
    user: safeUser(user),
    rawToken: token,
    vlessLink: renderVlessLink(state, user.id),
    subscriptionUrl: base ? `${base}/s/${encodeURIComponent(token)}` : null,
    revision: state.revision,
    csrf,
  };
}

export async function snapshot(controller, sessionId) {
  controller.session(sessionId);
  const current = await controller.state();
  const liveUsers = current.state.users.filter((user) => user.status !== 'revoked');
  const revokedUsers = current.state.users.filter((user) => user.status === 'revoked');
  const visibleRevoked = revokedUsers.slice(-64);
  let exitNodes = [];
  let exitDirectoryAvailable = false;
  try {
    const credential = await controller.exitDirectoryCredential(current.state);
    if (credential) {
      exitNodes = await controller.exitDirectory(credential);
      exitDirectoryAvailable = true;
    }
  } catch {
    exitNodes = [];
  }
  const selected = exitNodes.find((node) => (
    node.ipv4 === current.state.tailscale.exitNode
    || node.ipv6 === current.state.tailscale.exitNode
    || node.name === current.state.tailscale.exitNode
  ));
  const csrf = controller.sessions.currentCsrf(sessionId);
  if (!csrf) throw new ControllerError('UNAUTHORIZED', 401);
  return {
    revision: current.state.revision,
    csrf,
    ready: controller.ready,
    gateway: {
      vpnPublicHostname: current.state.gateway.vpnPublicHostname,
      publicPort: 443,
      subscriptionPublicBaseUrl: current.state.gateway.subscriptionPublicBaseUrl,
      adminPublicHostname: current.state.gateway.adminPublicHostname,
      exitNode: {
        deviceId: selected?.deviceId ?? null,
        address: current.state.tailscale.exitNode,
      },
    },
    exitNodes,
    exitDirectoryAvailable,
    selectableExits: (current.state.tailscale.extraExits ?? []).map(({ id, name, address }) => ({ id, name, address })),
    users: [...liveUsers, ...visibleRevoked].map(safeUser),
    revokedOmitted: revokedUsers.length - visibleRevoked.length,
  };
}
