import { deriveExitHealthPassword } from '../identity/exit-profiles.js';
import { HEALTH_USERNAME, VLESS_LISTEN_HOST, VLESS_LISTEN_PORT } from '../model/policy.js';
import { validateState } from '../model/state.js';
import { renderServerConfig } from './model.js';
import { assertFailClosedConfig } from './assert.js';

export function renderSingBoxConfig(value) {
  const state = validateState(value);
  return assertFailClosedConfig(renderServerConfig(state), state);
}

export function buildRuntimeHealth(value) {
  const state = validateState(value);
  const health = {
    listenHost: VLESS_LISTEN_HOST,
    listenPort: state.health.listenPort,
    username: state.health.username,
    password: state.health.password,
    targetHost: state.health.target.host,
    targetPort: state.health.target.port,
    websocket: {
      connectHost: VLESS_LISTEN_HOST,
      connectPort: VLESS_LISTEN_PORT,
      authority: state.gateway.vpnPublicHostname,
      path: state.gateway.websocketPath,
    },
  };
  if ((state.tailscale.extraExits?.length ?? 0) > 0) {
    health.profiles = [
      { username: state.health.username, password: state.health.password },
      ...state.tailscale.extraExits.map((exit) => ({
        username: `${HEALTH_USERNAME}-${exit.id}`,
        password: deriveExitHealthPassword(state.health.password, exit.id),
      })),
    ];
  }
  return health;
}
