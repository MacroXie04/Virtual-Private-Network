import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createAdminServer } from '../../src/http/admin/application.js';
import { ControlError } from '../../src/control/socket/client-transport.js';
import { MANAGEMENT_PATHS } from '../../src/http/admin/routes.js';
import { request } from '../helpers/admin-http.js';

const SESSION = 'f'.repeat(32);

test('the router admits exactly the management paths to the administrator pipeline', async (t) => {
  const calls = [];
  const control = new Proxy({}, {
    get: (_target, method) => async (...args) => {
      calls.push([method, ...args]);
      throw new ControlError('UNAUTHORIZED', 401);
    },
  });
  const service = createAdminServer({ host: '127.0.0.1', port: 0, publicHostname: 'admin.test', control });
  const address = await service.listen();
  t.after(() => service.close());
  const headers = { cookie: `__Host-vpn_admin_session=${SESSION}` };

  // Unlisted paths are answered before the cookie is read: no controller call, nothing cleared.
  for (const pathname of ['/healthz', '/index.html', '/robots.txt', '/overviewx', '/users-x', '/assets/other.js', '/x/y', '/login-x']) {
    for (const method of ['GET', 'HEAD', 'DELETE']) {
      const response = await request(address, pathname, { method, headers });
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.equal(response.headers['set-cookie'], undefined);
    }
  }
  assert.deepEqual(calls, []);

  // Every listed path and everything beneath it presents the cookie to the controller.
  const gated = MANAGEMENT_PATHS.flatMap((base) => (base === '/login' ? [`${base}/child`] : [base, `${base}/child`]));
  for (const pathname of gated) {
    const response = await request(address, pathname, { headers });
    assert.equal(response.status, 303, pathname);
    assert.equal(response.headers.location, '/login');
    assert.deepEqual(calls.at(-1), ['checkSession', SESSION]);
  }
  assert.equal(calls.length, gated.length);

  // The sign-in page itself never consults the session.
  assert.equal((await request(address, '/login', { headers })).status, 200);
  assert.equal(calls.length, gated.length);
});

test('the deployment guide scopes the administrator Access application to exactly the management paths', async () => {
  const guide = await readFile(new URL('../../docs/deployment.md', import.meta.url), 'utf8');
  const bullet = guide.split('\n').find((line) => line.startsWith('- **Public home page.**'));
  assert.ok(bullet, 'the public-home-page layout is documented');
  const enumerated = /management paths ((?:`\/[a-z-]+`(?:, | and |, and ))*`\/[a-z-]+`)/u.exec(bullet);
  assert.ok(enumerated, 'the layout enumerates the management paths');
  assert.deepEqual([...enumerated[1].matchAll(/`(\/[a-z-]+)`/gu)].map((match) => match[1]), [...MANAGEMENT_PATHS]);
  assert.doesNotMatch(guide, /`\/account\/\*`(?! does not cover| following an earlier)/u, 'the portal bypass is spelled /account');
});
