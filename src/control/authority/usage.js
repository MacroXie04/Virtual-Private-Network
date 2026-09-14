import path from 'node:path';
import { rename, unlink } from 'node:fs/promises';
import { parseUserCounter, queryTrafficCounters } from '../../runtime/stats/client.js';
import { PRIVATE_GID, SERVICE_UID } from '../../state/filesystem/policy.js';
import { isMissing, readNoFollow, safeLstat, syncDirectory, writeExclusive } from '../../state/filesystem/files.js';

export const USAGE_SCHEMA_VERSION = 1;
const MAX_USAGE_BYTES = 4 * 1024 * 1024;

function byteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseUsageFile(bytes) {
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (parsed?.schemaVersion !== USAGE_SCHEMA_VERSION
    || typeof parsed.users !== 'object' || parsed.users === null
    || typeof parsed.counters !== 'object' || parsed.counters === null) {
    throw new TypeError('unsupported usage file');
  }
  const users = new Map();
  for (const [id, entry] of Object.entries(parsed.users)) {
    const uplinkBytes = byteCount(entry?.uplinkBytes);
    const downlinkBytes = byteCount(entry?.downlinkBytes);
    if (uplinkBytes === null || downlinkBytes === null || typeof entry.updatedAt !== 'string') {
      throw new TypeError('invalid usage record');
    }
    users.set(id, { uplinkBytes, downlinkBytes, updatedAt: entry.updatedAt });
  }
  const counters = new Map();
  for (const [name, value] of Object.entries(parsed.counters)) {
    const count = byteCount(value);
    if (count === null) throw new TypeError('invalid usage counter');
    counters.set(name, count);
  }
  return { users, counters };
}

/**
 * Accumulate per-user traffic from sing-box's cumulative counters. Counters
 * restart from zero whenever sing-box restarts, so only deltas are folded into
 * the persisted lifetime totals; the last observed counter values are stored
 * alongside them so a controller restart neither double counts nor loses data.
 */
export class UsageTracker {
  constructor({ path: filePath, query = queryTrafficCounters, now = () => new Date() } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('usage path must be absolute');
    if (typeof query !== 'function' || typeof now !== 'function') throw new TypeError('usage query and clock must be functions');
    this.path = filePath;
    this.query = query;
    this.now = now;
    this.users = new Map();
    this.counters = new Map();
    this.chain = Promise.resolve();
  }

  async load() {
    if (await safeLstat(this.path) === null) return false;
    const bytes = await readNoFollow(this.path, { maxBytes: MAX_USAGE_BYTES, expectedMode: 0o600 });
    const parsed = parseUsageFile(bytes);
    this.users = parsed.users;
    this.counters = parsed.counters;
    return true;
  }

  /** Forget the last counter values; the next sample starts from zero again. */
  markRestarted() {
    this.counters.clear();
  }

  forUser(userId) {
    const entry = this.users.get(userId);
    return entry ? { ...entry } : null;
  }

  /** Query, fold and persist; concurrent calls are serialized. */
  sample() {
    const run = () => this.collect();
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async collect() {
    const counters = await this.query();
    const timestamp = this.now().toISOString();
    const observed = new Map();
    let changed = false;
    for (const { name, value } of counters) {
      const parsed = parseUserCounter(name);
      if (parsed === null || !Number.isSafeInteger(value) || value < 0) continue;
      const previous = this.counters.get(name);
      const delta = previous === undefined || value < previous ? value : value - previous;
      observed.set(name, value);
      if (delta === 0) continue;
      const entry = this.users.get(parsed.userId) ?? { uplinkBytes: 0, downlinkBytes: 0, updatedAt: timestamp };
      entry[`${parsed.direction}Bytes`] += delta;
      entry.updatedAt = timestamp;
      this.users.set(parsed.userId, entry);
      changed = true;
    }
    const countersChanged = observed.size !== this.counters.size
      || [...observed].some(([name, value]) => this.counters.get(name) !== value);
    this.counters = observed;
    if (changed || countersChanged) await this.persist();
    return changed;
  }

  async persist() {
    const temporary = `${this.path}.tmp`;
    await unlink(temporary).catch((error) => {
      if (!isMissing(error)) throw error;
    });
    const payload = Buffer.from(`${JSON.stringify({
      schemaVersion: USAGE_SCHEMA_VERSION,
      users: Object.fromEntries(this.users),
      counters: Object.fromEntries(this.counters),
    }, null, 2)}\n`, 'utf8');
    await writeExclusive(temporary, payload, 0o600, SERVICE_UID, PRIVATE_GID);
    await rename(temporary, this.path);
    await syncDirectory(path.dirname(this.path));
  }
}
