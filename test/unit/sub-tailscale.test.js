import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maskAuthKey,
  parseTsOutbound,
  updateTsOutbound,
  fetchExitNodes,
} from '../../sub/tailscale.js';

const config = {
  endpoints: [
    {
      type: 'tailscale',
      tag: 'ts-out',
      state_directory: '/var/lib/sing-box/tailscale',
      auth_key: 'tskey-auth-abcdef123456',
      hostname: 'proxy-vps',
      exit_node: '100.64.0.1',
      ephemeral: false,
    },
  ],
  outbounds: [{ type: 'direct', tag: 'direct' }],
};

test('parseTsOutbound extracts current state and masks the auth key', () => {
  const state = parseTsOutbound(config);
  assert.equal(state.exitNode, '100.64.0.1');
  assert.equal(state.hasAuthKey, true);
  assert.equal(state.maskedAuthKey, '****3456');
  assert.equal(state.hostname, 'proxy-vps');
});

test('parseTsOutbound throws when ts-out is not found', () => {
  assert.throws(() => parseTsOutbound({ endpoints: [] }), /ts-out/);
});

test('maskAuthKey handles empty values and short keys', () => {
  assert.equal(maskAuthKey(''), '');
  assert.equal(maskAuthKey(undefined), '');
  assert.equal(maskAuthKey('abc'), '****');
});

test('updateTsOutbound updates exit node and auth key', () => {
  const next = updateTsOutbound(config, { authKey: 'tskey-auth-newkey9999', exitNode: '100.64.0.2' });
  const ts = next.endpoints.find((o) => o.tag === 'ts-out');
  assert.equal(ts.exit_node, '100.64.0.2');
  assert.equal(ts.auth_key, 'tskey-auth-newkey9999');
  // does not mutate the original object
  assert.equal(config.endpoints[0].exit_node, '100.64.0.1');
  // the rest of the config is preserved as-is
  assert.deepEqual(next.outbounds, [{ type: 'direct', tag: 'direct' }]);
});

test('updateTsOutbound keeps the original auth key when authKey is empty', () => {
  const next = updateTsOutbound(config, { authKey: '', exitNode: 'my-exit-node' });
  const ts = next.endpoints.find((o) => o.tag === 'ts-out');
  assert.equal(ts.exit_node, 'my-exit-node');
  assert.equal(ts.auth_key, 'tskey-auth-abcdef123456');
});

test('updateTsOutbound rejects invalid exit nodes', () => {
  assert.throws(() => updateTsOutbound(config, { exitNode: '' }), /Exit Node/);
  assert.throws(() => updateTsOutbound(config, { exitNode: 'a b"c' }), /Exit Node/);
});

test('updateTsOutbound throws when ts-out is not found', () => {
  assert.throws(() => updateTsOutbound({ endpoints: [] }, { exitNode: '100.64.0.2' }), /ts-out/);
});

test('fetchExitNodes keeps only devices advertising default routes', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      devices: [
        { hostname: 'exit-a', name: 'exit-a.tailnet.ts.net', addresses: ['100.64.0.1', 'fd7a::1'], advertisedRoutes: ['0.0.0.0/0', '::/0'] },
        { hostname: 'exit-b', name: 'exit-b.tailnet.ts.net', addresses: ['100.64.0.2'], advertisedRoutes: ['0.0.0.0/0'] },
        { hostname: 'laptop', name: 'laptop.tailnet.ts.net', addresses: ['100.64.0.3'], advertisedRoutes: ['10.0.0.0/8'] },
      ],
    }),
  });
  const nodes = await fetchExitNodes('tskey-api-xxx', fakeFetch);
  assert.deepEqual(nodes, [
    { name: 'exit-a', ip: '100.64.0.1' },
    { name: 'exit-b', ip: '100.64.0.2' },
  ]);
});

test('fetchExitNodes returns an empty array when the API fails', async () => {
  const httpError = await fetchExitNodes('bad-key', async () => ({ ok: false, status: 401 }));
  assert.deepEqual(httpError, []);
  const netError = await fetchExitNodes('key', async () => { throw new Error('network down'); });
  assert.deepEqual(netError, []);
});
