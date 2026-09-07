import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSubscriptionServer } from '../../src/http/subscription-application.js';
import { readSubscriptionView } from '../../src/http/subscription-data.js';

import { request, projection } from '../helpers/subscription-http.js';

test('maintenance marker gates valid subscription routes before projection reads', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-sub-maintenance-test-'));
  const current = path.join(directory, 'current');
  await mkdir(current);
  const projectionPath = path.join(current, 'subscription-view.json');
  const markerPath = path.join(directory, 'maintenance');
  const token = 'F'.repeat(43);
  await writeFile(projectionPath, JSON.stringify(projection(token)));
  await writeFile(markerPath, 'switching\n', { mode: 0o600 });
  let projectionReads = 0;
  const service = createSubscriptionServer({
    dataDir: directory,
    host: '127.0.0.1',
    port: 0,
    loadView: async () => {
      projectionReads += 1;
      return readSubscriptionView(projectionPath);
    },
  });
  const address = await service.listen();
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });

  const maintenance = await request(address, `/s/${token}/links`);
  assert.equal(maintenance.status, 503);
  assert.equal(maintenance.headers['retry-after'], '1');
  assert.equal((await request(address, '/not-a-subscription')).status, 404);
  assert.equal(projectionReads, 0);

  await rm(markerPath);
  assert.equal((await request(address, `/s/${token}/links`)).status, 200);
  assert.equal(projectionReads, 1);
});

test('maintenance beginning during a projection read suppresses the credential response', async (t) => {
  const token = 'K'.repeat(43);
  let maintenanceChecks = 0;
  let projectionReads = 0;
  const service = createSubscriptionServer({
    host: '127.0.0.1',
    port: 0,
    loadView: async () => {
      projectionReads += 1;
      return projection(token);
    },
    checkMaintenance: async () => {
      maintenanceChecks += 1;
      return maintenanceChecks > 1;
    },
  });
  const address = await service.listen();
  t.after(() => service.close());

  const response = await request(address, `/s/${token}/links`);
  assert.equal(response.status, 503);
  assert.equal(response.headers['retry-after'], '1');
  assert.equal(projectionReads, 1);
  assert.equal(maintenanceChecks, 2);
});

test('projection reader refuses a symlink in place of the immutable view file', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-sub-symlink-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const realPath = path.join(directory, 'real.json');
  const linkedPath = path.join(directory, 'subscription-view.json');
  await writeFile(realPath, JSON.stringify(projection('G'.repeat(43))));
  await symlink('real.json', linkedPath);
  await assert.rejects(readSubscriptionView(linkedPath), /subscription data unavailable/u);
});
