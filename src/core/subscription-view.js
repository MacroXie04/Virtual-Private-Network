import {
  MAX_USERS,
  PUBLIC_VLESS_PORT,
  SUBSCRIPTION_VIEW_SCHEMA_VERSION,
  validateExtraExits,
  validateState,
} from './state-schema.js';
import { assertUniqueUsers, validateProjectedUser } from './user-records.js';
import {
  ValidationError,
  expectExactKeys,
  expectInteger,
  validatePort,
  validatePublicDnsHostname,
  validateWebSocketPath,
} from './validation.js';

export function validateSubscriptionView(value) {
  const view = expectExactKeys(value, [
    'schemaVersion',
    'revision',
    'gateway',
    'users',
    ...(Object.hasOwn(value ?? {}, 'exits') ? ['exits'] : []),
  ], 'subscriptionView');
  if (view.schemaVersion !== SUBSCRIPTION_VIEW_SCHEMA_VERSION) {
    throw new ValidationError('subscriptionView.schemaVersion', `must be ${SUBSCRIPTION_VIEW_SCHEMA_VERSION}`);
  }
  const gateway = expectExactKeys(
    view.gateway,
    ['vpnPublicHostname', 'subscriptionPublicHostname', 'port', 'websocketPath'],
    'subscriptionView.gateway',
  );
  if (!Array.isArray(view.users)) throw new ValidationError('subscriptionView.users', 'must be an array');
  if (view.users.length > MAX_USERS) {
    throw new ValidationError('subscriptionView.users', `must contain at most ${MAX_USERS} active users`);
  }
  const users = view.users.map((user, index) => validateProjectedUser(user, `subscriptionView.users[${index}]`));
  assertUniqueUsers(users.map((user) => ({ ...user, status: 'active' })));
  const normalizedGateway = {
    vpnPublicHostname: validatePublicDnsHostname(
      gateway.vpnPublicHostname,
      'subscriptionView.gateway.vpnPublicHostname',
    ),
    subscriptionPublicHostname: validatePublicDnsHostname(
      gateway.subscriptionPublicHostname,
      'subscriptionView.gateway.subscriptionPublicHostname',
    ),
    port: (() => {
      const port = validatePort(gateway.port, 'subscriptionView.gateway.port');
      if (port !== PUBLIC_VLESS_PORT) {
        throw new ValidationError('subscriptionView.gateway.port', `must be ${PUBLIC_VLESS_PORT}`);
      }
      return port;
    })(),
    websocketPath: validateWebSocketPath(
      gateway.websocketPath,
      'subscriptionView.gateway.websocketPath',
    ),
  };
  if (normalizedGateway.vpnPublicHostname === normalizedGateway.subscriptionPublicHostname) {
    throw new ValidationError('subscriptionView.gateway', 'VPN and subscription hostnames must be distinct');
  }
  return {
    schemaVersion: SUBSCRIPTION_VIEW_SCHEMA_VERSION,
    revision: expectInteger(view.revision, 'subscriptionView.revision', { min: 0 }),
    gateway: normalizedGateway,
    users,
    ...(Object.hasOwn(view, 'exits')
      ? { exits: validateExtraExits(view.exits, 'subscriptionView.exits', true) }
      : {}),
  };
}

export function buildSubscriptionView(value) {
  const state = validateState(value);
  return validateSubscriptionView({
    schemaVersion: SUBSCRIPTION_VIEW_SCHEMA_VERSION,
    revision: state.revision,
    gateway: {
      vpnPublicHostname: state.gateway.vpnPublicHostname,
      subscriptionPublicHostname: new URL(state.gateway.subscriptionPublicBaseUrl).hostname,
      port: PUBLIC_VLESS_PORT,
      websocketPath: state.gateway.websocketPath,
    },
    users: state.users
      .filter((user) => user.status === 'active')
      .map((user) => ({
        id: user.id,
        displayName: user.displayName,
        uuid: user.uuid,
        tokenHash: user.tokenHash,
      })),
    ...((state.tailscale.extraExits?.length ?? 0) > 0
      ? { exits: state.tailscale.extraExits.map(({ id, name }) => ({ id, name })) }
      : {}),
  });
}

export const parseSubscriptionView = validateSubscriptionView;
export const renderSubscriptionView = buildSubscriptionView;
