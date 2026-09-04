import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyHost,
  deriveRealityPublicKey,
  formatAuthorityHost,
  validateAbsoluteStatePath,
  validatePublicBaseUrl,
} from '../../src/validation.js';
import {
  validateState,
  validateSubscriptionView,
} from '../../src/state-schema.js';
import { buildSubscriptionView } from '../../src/render.js';
import { fixtureState } from './core-v2-fixture.js';

test('REALITY keys are canonical X25519 material and form a matching pair', () => {
  const state = fixtureState();
  assert.equal(deriveRealityPublicKey(state.reality.privateKey), state.reality.publicKey);

  const mismatched = fixtureState();
  mismatched.reality.publicKey = 'zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk';
  assert.throws(() => validateState(mismatched), /must correspond/u);

  const padded = fixtureState();
  padded.reality.privateKey = `${state.reality.privateKey}=`;
  assert.throws(() => validateState(padded), /state\.reality\.privateKey/u);

  const shortProjection = buildSubscriptionView(state);
  shortProjection.reality.publicKey = 'too-short';
  assert.throws(() => validateSubscriptionView(shortProjection), /base64url X25519/u);
});

test('host validation preserves an explicit DNS/IP kind and formats IPv6 authorities', () => {
  assert.deepEqual(classifyHost('VPN.Example.COM.'), { kind: 'dns', value: 'vpn.example.com' });
  assert.deepEqual(classifyHost('192.0.2.4'), { kind: 'ipv4', value: '192.0.2.4' });
  const ipv6 = classifyHost('2001:0db8:0:0:0:0:0:1');
  assert.deepEqual(ipv6, { kind: 'ipv6', value: '2001:db8::1' });
  assert.equal(formatAuthorityHost(ipv6), '[2001:db8::1]');
  assert.throws(() => formatAuthorityHost({ kind: 'dns', value: '2001:db8::1' }), /does not match ipv6/);
});

test('public base URL accepts only normalized HTTPS origins and paths', () => {
  assert.equal(
    validatePublicBaseUrl('https://VPN.Example.com/subscriptions/'),
    'https://vpn.example.com/subscriptions',
  );
  assert.throws(() => validatePublicBaseUrl('http://vpn.example.com'), /must use https/);
  assert.throws(() => validatePublicBaseUrl('https://vpn.example.com:8443'), /port 443/);
  assert.throws(() => validatePublicBaseUrl('https://vpn.example.com/a%2fb'), /unsafe/);
  assert.throws(() => validatePublicBaseUrl('https://user:secret@vpn.example.com'), /credentials/);
});

test('state paths reject ambiguous separators and dot segments', () => {
  assert.equal(validateAbsoluteStatePath('/var/lib/vpn-gateway/tailscale'), '/var/lib/vpn-gateway/tailscale');
  for (const candidate of [
    '/var/lib/vpn-gateway/',
    '/var/lib/./vpn-gateway',
    '/var/lib/../vpn-gateway',
    '/var/lib//vpn-gateway',
    '/var/lib/vpn\\gateway',
  ]) {
    assert.throws(() => validateAbsoluteStatePath(candidate), /normalized absolute path/u);
  }
});

test('schema v2 returns a normalized clone and rejects raw credentials or unknown fields', () => {
  const input = fixtureState();
  input.gateway.host.value = 'VPN.Example.COM.';
  const state = validateState(input);
  assert.notEqual(state, input);
  assert.equal(state.gateway.host.value, 'vpn.example.com');

  const withRawToken = fixtureState();
  withRawToken.users[0].token = 'this-must-never-be-persisted';
  assert.throws(() => validateState(withRawToken), /state\.users\[0\]\.token: is not allowed/);

  const withRawPassword = fixtureState();
  withRawPassword.admin.password = 'also-forbidden';
  assert.throws(() => validateState(withRawPassword), /state\.admin\.password: is not allowed/);

  const unauthenticatedHealth = fixtureState();
  delete unauthenticatedHealth.health.password;
  assert.throws(() => validateState(unauthenticatedHealth), /state\.health\.password: is required/);

  const weakHealth = fixtureState();
  weakHealth.health.password = 'guessable';
  assert.throws(() => validateState(weakHealth), /state\.health\.password/u);

  const unexpectedHealthUser = fixtureState();
  unexpectedHealthUser.health.username = 'anonymous';
  assert.throws(() => validateState(unexpectedHealthUser), /state\.health\.username/u);

  const yamlLineBreak = fixtureState();
  yamlLineBreak.users[0].displayName = 'Alice\u0085injected';
  assert.throws(() => validateState(yamlLineBreak), /control characters/u);

  const bidiSpoof = fixtureState();
  bidiSpoof.users[0].displayName = 'Alice\u202Etxt.exe';
  assert.throws(() => validateState(bidiSpoof), /invisible formatting/u);
});

test('schema couples readiness to exit-routed DNS and the REALITY origin', () => {
  const wrongHost = fixtureState();
  wrongHost.health.target.host = '1.1.1.1';
  assert.throws(() => validateState(wrongHost), /state\.health\.target/u);

  const wrongPort = fixtureState();
  wrongPort.health.target.port = 8443;
  assert.throws(() => validateState(wrongPort), /state\.health\.target/u);
});

test('schema enforces lifecycle timestamps, unique credentials, and global chronology', () => {
  const invalidActive = fixtureState();
  invalidActive.users[0].disabledAt = invalidActive.updatedAt;
  assert.throws(() => validateState(invalidActive), /active users cannot have/);

  const duplicate = fixtureState({
    users: [
      fixtureState().users[0],
      { ...fixtureState().users[0], id: 'alice-two', displayName: 'Alice Two' },
    ],
  });
  assert.throws(() => validateState(duplicate), /uuid: must be unique/);

  const futureUser = fixtureState();
  futureUser.users[0].updatedAt = '2026-09-04T00:01:00.000Z';
  assert.throws(() => validateState(futureUser), /must not follow state.updatedAt/);
});

test('subscription projection is exact, public-only, and contains active users', () => {
  const view = buildSubscriptionView(fixtureState());
  assert.deepEqual(Object.keys(view), ['schemaVersion', 'revision', 'gateway', 'reality', 'users']);
  assert.equal(view.schemaVersion, 1);
  assert.equal(Object.hasOwn(view.reality, 'privateKey'), false);
  assert.equal(Object.hasOwn(view, 'tailscale'), false);
  assert.equal(view.users.length, 1);
  assert.deepEqual(validateSubscriptionView(view), view);

  const leaked = structuredClone(view);
  leaked.reality.privateKey = 'UuMBgl7MXTPx9inmQp2UC7Jcnwc6XYbwDNebonM-FCc'; // gitleaks:allow -- deterministic test vector
  assert.throws(() => validateSubscriptionView(leaked), /privateKey: is not allowed/);
});
