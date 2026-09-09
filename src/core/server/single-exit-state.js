import { validateState } from '../model/state.js';
import { ValidationError } from '../validation/values.js';

function fail(path, message) {
  throw new ValidationError(path, message);
}

export function assertSingleExitState({ endpoint, publicInbound, healthInbound }, expectedState) {
  if (expectedState !== null) {
    const state = validateState(expectedState);
    const expectedUsers = state.users.filter((user) => user.status === 'active');
    if (publicInbound.users.length !== expectedUsers.length) {
      fail('config.inbounds.vless-in.users', 'does not match active state users');
    }
    expectedUsers.forEach((user, index) => {
      const rendered = publicInbound.users[index];
      if (rendered.name !== user.id || rendered.uuid !== user.uuid) {
        fail(`config.inbounds.vless-in.users[${index}]`, 'does not match active state user');
      }
    });
    if (healthInbound.listen_port !== state.health.listenPort) {
      fail('config.inbounds', 'listen ports do not match state');
    }
    if (healthInbound.users[0].username !== state.health.username
      || healthInbound.users[0].password !== state.health.password) {
      fail('config.inbounds.health-in.users[0]', 'does not match health probe credentials');
    }
    if (publicInbound.transport.path !== state.gateway.websocketPath) {
      fail('config.inbounds.vless-in.transport.path', 'does not match state');
    }
    if (endpoint.state_directory !== state.tailscale.stateDirectory
      || endpoint.hostname !== state.tailscale.hostname
      || endpoint.exit_node !== state.tailscale.exitNode
      || (state.tailscale.authKey === null
        ? Object.hasOwn(endpoint, 'auth_key')
        : endpoint.auth_key !== state.tailscale.authKey)) {
      fail('config.endpoints[0]', 'does not match state');
    }
  }
}
