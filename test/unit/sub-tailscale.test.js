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

test('parseTsOutbound 提取当前状态并掩码 auth key', () => {
  const state = parseTsOutbound(config);
  assert.equal(state.exitNode, '100.64.0.1');
  assert.equal(state.hasAuthKey, true);
  assert.equal(state.maskedAuthKey, '****3456');
  assert.equal(state.hostname, 'proxy-vps');
});

test('parseTsOutbound 找不到 ts-out 时抛错', () => {
  assert.throws(() => parseTsOutbound({ endpoints: [] }), /ts-out/);
});

test('maskAuthKey 处理空值与短 key', () => {
  assert.equal(maskAuthKey(''), '');
  assert.equal(maskAuthKey(undefined), '');
  assert.equal(maskAuthKey('abc'), '****');
});

test('updateTsOutbound 更新 exit node 与 auth key', () => {
  const next = updateTsOutbound(config, { authKey: 'tskey-auth-newkey9999', exitNode: '100.64.0.2' });
  const ts = next.endpoints.find((o) => o.tag === 'ts-out');
  assert.equal(ts.exit_node, '100.64.0.2');
  assert.equal(ts.auth_key, 'tskey-auth-newkey9999');
  // 不修改原对象
  assert.equal(config.endpoints[0].exit_node, '100.64.0.1');
  // 其余配置原样保留
  assert.deepEqual(next.outbounds, [{ type: 'direct', tag: 'direct' }]);
});

test('updateTsOutbound authKey 为空时保留原值', () => {
  const next = updateTsOutbound(config, { authKey: '', exitNode: 'my-exit-node' });
  const ts = next.endpoints.find((o) => o.tag === 'ts-out');
  assert.equal(ts.exit_node, 'my-exit-node');
  assert.equal(ts.auth_key, 'tskey-auth-abcdef123456');
});

test('updateTsOutbound 拒绝非法 exit node', () => {
  assert.throws(() => updateTsOutbound(config, { exitNode: '' }), /Exit Node/);
  assert.throws(() => updateTsOutbound(config, { exitNode: 'a b"c' }), /Exit Node/);
});

test('updateTsOutbound 找不到 ts-out 时抛错', () => {
  assert.throws(() => updateTsOutbound({ endpoints: [] }, { exitNode: '100.64.0.2' }), /ts-out/);
});

test('fetchExitNodes 只保留宣告了默认路由的设备', async () => {
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

test('fetchExitNodes API 失败时返回空数组', async () => {
  const httpError = await fetchExitNodes('bad-key', async () => ({ ok: false, status: 401 }));
  assert.deepEqual(httpError, []);
  const netError = await fetchExitNodes('key', async () => { throw new Error('network down'); });
  assert.deepEqual(netError, []);
});
