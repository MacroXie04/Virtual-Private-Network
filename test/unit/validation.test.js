import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyHost,
  formatAuthorityHost,
  validateAbsoluteStatePath,
  validatePublicDnsHostname,
  validateSubscriptionPublicBaseUrl,
  validateWebSocketPath,
} from '../../src/core/validation.js';
import { validateState } from '../../src/core/state-schema.js';
import { validateSubscriptionView } from '../../src/core/subscription-view.js';
import { buildSubscriptionView } from '../../src/core/subscription-view.js';
import { fixtureState } from '../fixtures/state.js';

test('public Tunnel settings accept only canonical dedicated DNS origins', () => {
  assert.equal(validatePublicDnsHostname('VPN.Example.COM'), 'vpn.example.com');
  assert.equal(validateSubscriptionPublicBaseUrl('https://Sub.Example.com'), 'https://sub.example.com');
  for (const hostname of [
    '127.0.0.1', '127.1', '0177.0.0.1', '0x7f.0.0.1', '2130706433',
    '::1', 'localhost', 'singlelabel', 'vpn.example.com.',
  ]) {
    assert.throws(() => validatePublicDnsHostname(hostname), /public DNS|multi-label/u);
  }
  for (const url of [
    'http://sub.example.com', 'https://sub.example.com/', 'https://sub.example.com:8443',
    'https://127.1',
    'https://user:secret@sub.example.com', 'https://sub.example.com/path',
    'https://sub.example.com?query=1', 'https://sub.example.com#fragment',
  ]) assert.throws(() => validateSubscriptionPublicBaseUrl(url));
  const collision = fixtureState();
  collision.gateway.adminPublicHostname = 'VPN.EXAMPLE.COM';
  assert.throws(() => validateState(collision), /must be distinct/u);
});

test('WebSocket paths are absolute, high-entropy-shaped, and canonical', () => {
  const valid = `/${'a'.repeat(43)}`;
  assert.equal(validateWebSocketPath(valid), valid);
  for (const value of ['/', '/short', 'relative', `/${'a'.repeat(42)}`, '/a/b', '/abc?query']) {
    assert.throws(() => validateWebSocketPath(value), /URL-safe segment|length/u);
  }
});

test('generic host/path helpers preserve their non-public use cases', () => {
  assert.deepEqual(classifyHost('VPN.Example.COM.'), { kind: 'dns', value: 'vpn.example.com' });
  assert.deepEqual(classifyHost('192.0.2.4'), { kind: 'ipv4', value: '192.0.2.4' });
  const ipv6 = classifyHost('2001:0db8:0:0:0:0:0:1');
  assert.deepEqual(ipv6, { kind: 'ipv6', value: '2001:db8::1' });
  assert.equal(formatAuthorityHost(ipv6), '[2001:db8::1]');
  for (const candidate of [
    '/var/lib/vpn-gateway/', '/var/lib/./vpn-gateway', '/var/lib/../vpn-gateway',
    '/var/lib//vpn-gateway', '/var/lib/vpn\\gateway',
  ]) assert.throws(() => validateAbsoluteStatePath(candidate), /normalized absolute path/u);
});

test('schema v3 is exact and rejects raw credentials or unknown fields', () => {
  const input = fixtureState();
  input.gateway.vpnPublicHostname = 'VPN.Example.COM';
  const state = validateState(input);
  assert.notEqual(state, input);
  assert.equal(state.gateway.vpnPublicHostname, 'vpn.example.com');
  const withRawToken = fixtureState();
  withRawToken.users[0].token = 'this-must-never-be-persisted';
  assert.throws(() => validateState(withRawToken), /token: is not allowed/);
  const withReality = fixtureState();
  withReality.reality = { privateKey: 'forbidden' };
  assert.throws(() => validateState(withReality), /state\.reality: is not allowed/);
  const weakHealth = fixtureState();
  weakHealth.health.password = 'guessable';
  assert.throws(() => validateState(weakHealth), /state\.health\.password/u);
  const bidiSpoof = fixtureState();
  bidiSpoof.users[0].displayName = 'Alice\u202Etxt.exe';
  assert.throws(() => validateState(bidiSpoof), /invisible formatting/u);
});

test('schema requires an independent routed health DNS host on TCP 443', () => {
  for (const host of ['1.1.1.1', 'vpn.example.com', 'sub.example.com', 'admin.example.com']) {
    const invalid = fixtureState();
    invalid.health.target.host = host;
    assert.throws(() => validateState(invalid), /state\.health\.target/u);
  }
  const wrongPort = fixtureState();
  wrongPort.health.target.port = 8443;
  assert.throws(() => validateState(wrongPort), /state\.health\.target/u);
});

test('schema enforces lifecycle timestamps and unique credentials', () => {
  const invalidActive = fixtureState();
  invalidActive.users[0].disabledAt = invalidActive.updatedAt;
  assert.throws(() => validateState(invalidActive), /active users cannot have/);
  const duplicate = fixtureState({
    users: [fixtureState().users[0], {
      ...fixtureState().users[0], id: 'alice-two', displayName: 'Alice Two',
    }],
  });
  assert.throws(() => validateState(duplicate), /uuid: must be unique/);
});

test('subscription projection is exact, public-only, and pins its serving Host', () => {
  const view = buildSubscriptionView(fixtureState());
  assert.deepEqual(Object.keys(view), ['schemaVersion', 'revision', 'gateway', 'users']);
  assert.equal(view.schemaVersion, 2);
  assert.deepEqual(view.gateway, {
    vpnPublicHostname: 'vpn.example.com',
    subscriptionPublicHostname: 'sub.example.com',
    port: 443,
    websocketPath: '/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });
  assert.equal(Object.hasOwn(view, 'tailscale'), false);
  assert.deepEqual(validateSubscriptionView(view), view);
  const leaked = structuredClone(view);
  leaked.reality = { publicKey: 'forbidden' };
  assert.throws(() => validateSubscriptionView(leaked), /reality: is not allowed/);
});
