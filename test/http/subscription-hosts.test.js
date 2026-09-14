import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubscriptionServer } from '../../src/http/subscription/application.js';
import { hasCanonicalSubscriptionHost } from '../../src/http/subscription/request.js';
import { projection, request } from '../helpers/subscription-http.js';

test('subscription worker accepts the configured shared hostname and preserves the original origin', async (t) => {
  const token = 'J'.repeat(43);
  const service = createSubscriptionServer({
    port: 0, sharedHostname: 'ADMIN.example.com',
    loadView: async () => projection(token), checkMaintenance: async () => false,
  });
  const address = await service.listen();
  t.after(() => service.close());
  for (const Host of ['admin.example.com', 'ADMIN.example.com', 'sub.example.com']) {
    const response = await request(address, `/s/${token}/links`, { headers: { Host } });
    assert.equal(response.status, 200);
    assert.match(response.body.toString(), /^vless:\/\//u);
  }
  for (const Host of ['other.example.com', 'admin.example.com:443', '127.0.0.1']) {
    const response = await request(address, `/s/${token}`, {
      headers: { Host, 'X-Forwarded-Host': 'admin.example.com', Forwarded: 'host=admin.example.com' },
    });
    assert.equal(response.status, 404);
  }
});

test('shared hostname validation is explicit and never accepts duplicate Host or forwarded authority', () => {
  for (const sharedHostname of ['', 'localhost', '127.0.0.1', 'admin.example.com:443', 'https://admin.example.com']) {
    assert.throws(() => createSubscriptionServer({ port: 0, sharedHostname }));
  }
  const view = projection('K'.repeat(43));
  for (const rawHeaders of [
    [], ['Host', 'admin.example.com', 'host', 'admin.example.com'],
    ['Host', 'sub.example.com', 'host', 'admin.example.com'],
    ['X-Forwarded-Host', 'admin.example.com'],
    ['Host', 'other.example.com', 'Forwarded', 'host=admin.example.com'],
  ]) {
    assert.equal(hasCanonicalSubscriptionHost({ rawHeaders }, view, 'admin.example.com'), false);
  }
  assert.equal(hasCanonicalSubscriptionHost({ rawHeaders: ['Host', 'admin.example.com'] }, view, null), false);
  assert.equal(hasCanonicalSubscriptionHost({ rawHeaders: ['Host', 'sub.example.com'] }, view, null), true);
});
