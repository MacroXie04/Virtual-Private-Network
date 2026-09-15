import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  deriveExitHealthPassword,
  deriveExitUuid,
  exitProfileId,
  validateExitAddress,
} from '../../src/core/identity/exit-profiles.js';
import { buildSubscriptionView } from '../../src/core/subscriptions/view.js';
import { MAX_EXTRA_EXITS } from '../../src/core/identity/exit-profiles.js';
import { validateState } from '../../src/core/model/state.js';
import { validateSubscriptionView } from '../../src/core/subscriptions/view.js';
import { fixtureState } from '../fixtures/state.js';

function stateWithExits() {
  const state = fixtureState();
  state.tailscale.extraExits = [
    { id: exitProfileId('device-seoul'), name: 'seoul', address: '100.64.0.3', authKey: null },
    { id: exitProfileId('device-tokyo'), name: 'tokyo', address: 'fd7a:115c:a1e0::4', authKey: 'tskey-auth-bootstrap' },
  ];
  return state;
}

test('exit credentials are deterministic, separated by user and exit, and rotate with their roots', () => {
  const state = stateWithExits();
  const [seoul, tokyo] = state.tailscale.extraExits;
  assert.equal(seoul.id, createHash('sha256').update('device-seoul').digest('hex').slice(0, 16));
  const uuid = deriveExitUuid(state.users[0].uuid, seoul.id);
  assert.equal(uuid, '23c1fbac-69aa-405e-bfe6-a5c22d5efc22');
  assert.equal(uuid, deriveExitUuid(state.users[0].uuid, seoul.id));
  assert.match(uuid, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.notEqual(uuid, state.users[0].uuid);
  assert.notEqual(uuid, deriveExitUuid(state.users[0].uuid, tokyo.id));
  assert.notEqual(uuid, deriveExitUuid('00000000-0000-4000-8000-000000000002', seoul.id));
  const password = deriveExitHealthPassword(state.health.password, seoul.id);
  assert.deepEqual([...Buffer.from(password, 'base64url')], [
    12, 5, 252, 134, 47, 93, 6, 126, 201, 70, 102, 152, 62, 42, 136, 236,
    89, 178, 35, 141, 102, 79, 206, 14, 37, 65, 154, 71, 86, 17, 129, 21,
  ]);
  assert.equal(Buffer.from(password, 'base64url').length, 32);
  assert.equal(password, deriveExitHealthPassword(state.health.password, seoul.id));
  assert.notEqual(password, state.health.password);
  assert.notEqual(password, deriveExitHealthPassword(state.health.password, tokyo.id));
  assert.notEqual(password, deriveExitHealthPassword(Buffer.alloc(32, 8).toString('base64url'), seoul.id));
});

test('state accepts bounded private exit profiles without changing single-exit state shape', () => {
  assert.deepEqual(validateState(fixtureState()), fixtureState());
  assert.deepEqual(validateState(stateWithExits()), stateWithExits());
  assert.equal(validateExitAddress('FD7A:115C:A1E0:0:0:0:0:4'), 'fd7a:115c:a1e0::4');
  for (const address of ['1.1.1.1', '100.63.255.255', '100.128.0.1', '192.168.0.1',
    'fd7a:115c:a1e1::1', '::1', 'exit.example.com']) {
    assert.throws(() => validateExitAddress(address), /Tailscale IPv4 or IPv6/u);
  }
  const mutations = [
    (state) => { state.tailscale.extraExits[0].id = '../unsafe'; },
    (state) => { state.tailscale.extraExits[0].name = 'unsafe name'; },
    (state) => { state.tailscale.extraExits[0].authKey = ' bad secret '; },
    (state) => { state.tailscale.extraExits[1].id = state.tailscale.extraExits[0].id; },
    (state) => { state.tailscale.extraExits[1].name = 'SEOUL'; },
    (state) => { state.tailscale.extraExits[1].address = state.tailscale.extraExits[0].address; },
    (state) => { state.tailscale.extraExits = Array(MAX_EXTRA_EXITS + 1).fill(state.tailscale.extraExits[0]); },
  ];
  for (const mutate of mutations) {
    const state = stateWithExits();
    mutate(state);
    assert.throws(() => validateState(state));
  }
});

test('public projections expose only exit IDs and names and reject private additions', () => {
  const state = stateWithExits();
  const view = buildSubscriptionView(state);
  assert.deepEqual(view.exits, state.tailscale.extraExits.map(({ id, name }) => ({ id, name })));
  assert.deepEqual(validateSubscriptionView(view), view);
  for (const exit of state.tailscale.extraExits) {
    assert.equal(JSON.stringify(view).includes(exit.address), false);
    if (exit.authKey !== null) assert.equal(JSON.stringify(view).includes(exit.authKey), false);
  }
  for (const field of ['address', 'authKey', 'stateDirectory']) {
    const invalid = structuredClone(view);
    invalid.exits[0][field] = 'private';
    assert.throws(() => validateSubscriptionView(invalid), /is not allowed/u);
  }
  assert.equal(Object.hasOwn(buildSubscriptionView(fixtureState()), 'exits'), false);
});
