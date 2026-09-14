import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { USAGE_SCHEMA_VERSION, UsageTracker } from '../../src/control/authority/usage.js';

async function scratch(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vpn-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'usage.json');
}

const counter = (user, direction, value) => ({ name: `user>>>${user}>>>traffic>>>${direction}`, value });

test('usage folds counter deltas, detects restarts and persists per-user totals', async (t) => {
  const file = await scratch(t);
  let counters = [];
  const clock = { at: '2026-09-11T00:00:00.000Z' };
  const tracker = new UsageTracker({ path: file, query: async () => counters, now: () => new Date(clock.at) });
  assert.equal(await tracker.load(), false);
  assert.equal(await tracker.sample(), false);
  await assert.rejects(stat(file), (error) => error.code === 'ENOENT');

  counters = [counter('alice', 'uplink', 100), counter('alice', 'downlink', 40), { name: 'inbound>>>vless-in>>>traffic>>>uplink', value: 999 }];
  assert.equal(await tracker.sample(), true);
  assert.deepEqual(tracker.forUser('alice'), { uplinkBytes: 100, downlinkBytes: 40, updatedAt: clock.at });
  assert.equal(tracker.forUser('bob'), null);

  clock.at = '2026-09-11T00:00:30.000Z';
  counters = [counter('alice', 'uplink', 150), counter('alice', 'downlink', 40), counter('alice@0123456789abcdef', 'downlink', 10)];
  assert.equal(await tracker.sample(), true);
  assert.deepEqual(tracker.forUser('alice'), { uplinkBytes: 150, downlinkBytes: 50, updatedAt: clock.at });

  // A restart the controller knows about: counters begin again from zero.
  tracker.markRestarted();
  counters = [counter('alice', 'uplink', 20), counter('alice', 'downlink', 5)];
  await tracker.sample();
  assert.deepEqual(tracker.forUser('alice'), { uplinkBytes: 170, downlinkBytes: 55, updatedAt: clock.at });

  // A restart the controller did not observe: a lower value is a fresh counter.
  counters = [counter('alice', 'uplink', 5)];
  await tracker.sample();
  assert.equal(tracker.forUser('alice').uplinkBytes, 175);
  counters = [counter('alice', 'uplink', 5), counter('alice', 'downlink', 3)];
  await tracker.sample();
  assert.equal(tracker.forUser('alice').downlinkBytes, 58);

  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.schemaVersion, USAGE_SCHEMA_VERSION);
  assert.deepEqual(persisted.users.alice, { uplinkBytes: 175, downlinkBytes: 58, updatedAt: clock.at });
  assert.deepEqual(persisted.counters, { 'user>>>alice>>>traffic>>>uplink': 5, 'user>>>alice>>>traffic>>>downlink': 3 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  // A new controller continues from the stored counters instead of double counting.
  const reloaded = new UsageTracker({ path: file, query: async () => counters, now: () => new Date(clock.at) });
  assert.equal(await reloaded.load(), true);
  counters = [counter('alice', 'uplink', 9), counter('alice', 'downlink', 3)];
  assert.equal(await reloaded.sample(), true);
  assert.deepEqual(reloaded.forUser('alice'), { uplinkBytes: 179, downlinkBytes: 58, updatedAt: clock.at });
});

test('usage sampling is serialized and a failed query leaves totals untouched', async (t) => {
  const file = await scratch(t);
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const tracker = new UsageTracker({
    path: file,
    query: async () => {
      calls += 1;
      if (calls === 1) { order.push('slow-start'); await gate; order.push('slow-end'); return [counter('alice', 'uplink', 10)]; }
      if (calls === 2) { order.push('fast'); return [counter('alice', 'uplink', 30)]; }
      throw new Error('stats unavailable');
    },
  });
  const first = tracker.sample();
  const second = tracker.sample();
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(order, ['slow-start', 'slow-end', 'fast']);
  assert.equal(tracker.forUser('alice').uplinkBytes, 30);
  await assert.rejects(tracker.sample(), /stats unavailable/u);
  assert.equal(tracker.forUser('alice').uplinkBytes, 30);
});

test('usage tracker rejects corrupt files and invalid construction', async (t) => {
  const file = await scratch(t);
  await writeFile(file, '{"schemaVersion":1,"users":{"alice":{"uplinkBytes":-1}},"counters":{}}\n', { mode: 0o600 });
  await assert.rejects(new UsageTracker({ path: file, query: async () => [] }).load(), /invalid usage record/u);
  await writeFile(file, '{"schemaVersion":2,"users":{},"counters":{}}\n', { mode: 0o600 });
  await assert.rejects(new UsageTracker({ path: file, query: async () => [] }).load(), /unsupported usage file/u);
  assert.throws(() => new UsageTracker({ path: 'relative.json' }), TypeError);
  assert.throws(() => new UsageTracker({ path: file, query: 'nope' }), TypeError);
});
