import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExitNodeDirectoryError,
  fetchExitNodes,
  selectExitNode,
} from '../../src/tailscale.js';

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

test('exit-node directory returns only authorized devices with approved default routes', async () => {
  const nodes = await fetchExitNodes('secret-api-key', {
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer secret-api-key');
      return response({
        devices: [
          {
            id: 'node-a', hostname: 'exit-a', authorized: true,
            addresses: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
            advertisedRoutes: ['0.0.0.0/0', '::/0'],
            enabledRoutes: ['0.0.0.0/0', '::/0'],
          },
          {
            id: 'node-b', hostname: 'unapproved', authorized: true,
            addresses: ['100.64.0.2'], advertisedRoutes: ['0.0.0.0/0'], enabledRoutes: [],
          },
          {
            id: 'node-c', hostname: 'unauthorized', authorized: false,
            addresses: ['100.64.0.3'], advertisedRoutes: ['0.0.0.0/0'], enabledRoutes: ['0.0.0.0/0'],
          },
          {
            id: 'node-d', hostname: 'authorization-missing',
            addresses: ['100.64.0.4'], advertisedRoutes: ['0.0.0.0/0'], enabledRoutes: ['0.0.0.0/0'],
          },
          {
            id: 'node-e', hostname: 'route-mismatch', authorized: true,
            addresses: ['100.64.0.5'], advertisedRoutes: ['0.0.0.0/0'], enabledRoutes: ['::/0'],
          },
          {
            id: 'node-f', hostname: 'non-tailnet-ipv6', authorized: true,
            addresses: ['2001:db8::1'], advertisedRoutes: ['::/0'], enabledRoutes: ['::/0'],
          },
        ],
      });
    },
  });
  assert.deepEqual(nodes, [{
    deviceId: 'node-a', name: 'exit-a', ipv4: '100.64.0.1', ipv6: 'fd7a:115c:a1e0::1',
  }]);
});

test('exit-node directory enforces its timeout even if fetch ignores abort', async () => {
  await assert.rejects(fetchExitNodes('secret', {
    fetchImpl: async () => new Promise(() => {}),
    timeoutMs: 5,
  }), ExitNodeDirectoryError);
});

test('exit-node failures are sanitized and selection uses only returned device IDs', async () => {
  await assert.rejects(fetchExitNodes('do-not-leak', {
    fetchImpl: async () => response({}, { ok: false, status: 401 }),
  }), (error) => {
    assert.equal(error.message.includes('do-not-leak'), false);
    assert.equal(error.message.includes('401'), false);
    return true;
  });

  const selected = selectExitNode([
    { deviceId: 'node-a', name: 'exit-a', ipv4: '100.64.0.1', ipv6: null },
  ], 'node-a');
  assert.equal(selected.address, '100.64.0.1');
  assert.throws(() => selectExitNode([], 'attacker-value'), /not an approved exit node/);
});
