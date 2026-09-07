import { hashSubscriptionToken } from '../../src/core/credentials.js';
import { exitProfileId } from '../../src/core/exit-profiles.js';
import { fixtureState, fixtureUser } from './state.js';

export function lifecycleState() {
  return fixtureState({
    updatedAt: '2026-09-04T00:02:00.000Z',
    users: [
      fixtureUser(),
      fixtureUser({
        id: 'bob', displayName: 'Bob', uuid: '00000000-0000-4000-8000-000000000002',
        tokenHash: hashSubscriptionToken('b'.repeat(32)), status: 'disabled',
        updatedAt: '2026-09-04T00:01:00.000Z', disabledAt: '2026-09-04T00:01:00.000Z',
      }),
      fixtureUser({
        id: 'carol', displayName: 'Carol', uuid: '00000000-0000-4000-8000-000000000003',
        tokenHash: hashSubscriptionToken('c'.repeat(32)), status: 'revoked',
        updatedAt: '2026-09-04T00:02:00.000Z', revokedAt: '2026-09-04T00:02:00.000Z',
      }),
    ],
  });
}

export function multipleExitState() {
  const state = lifecycleState();
  state.tailscale.extraExits = [
    { id: exitProfileId('seoul-device'), name: 'seoul', address: '100.64.0.3', authKey: null },
    { id: exitProfileId('tokyo-device'), name: 'tokyo', address: 'fd7a:115c:a1e0::4', authKey: 'tskey-auth-extra' },
  ];
  return state;
}
