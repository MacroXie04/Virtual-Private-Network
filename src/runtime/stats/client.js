import { STATS_LISTEN_PORT, VLESS_LISTEN_HOST } from '../../core/model/policy.js';
import { grpcUnary } from './grpc.js';
import { decodeFields, encodeBoolField, encodeStringField, int64FromVarint } from './protobuf.js';

export const QUERY_STATS_METHOD = '/v2ray.core.app.stats.command.StatsService/QueryStats';
const USER_COUNTER = /^user>>>([A-Za-z0-9_-]+)(?:@([0-9a-f]{16}))?>>>traffic>>>(uplink|downlink)$/u;
const MAX_COUNTERS = 16 * 1024;

/**
 * Query sing-box's cumulative traffic counters. Each counter is named
 * `user>>>NAME>>>traffic>>>DIRECTION`; values restart from zero whenever
 * sing-box restarts, so callers must fold deltas rather than totals.
 */
export async function queryTrafficCounters({
  host = VLESS_LISTEN_HOST,
  port = STATS_LISTEN_PORT,
  pattern = 'user>>>',
  timeoutMs = 3_000,
  call = grpcUnary,
} = {}) {
  // QueryStatsRequest { string pattern = 1; bool reset = 2; }
  const message = Buffer.concat([encodeStringField(1, pattern), encodeBoolField(2, false)]);
  const [payload = Buffer.alloc(0)] = await call({ host, port, method: QUERY_STATS_METHOD, message, timeoutMs });
  // QueryStatsResponse { repeated Stat stat = 1; }  Stat { string name = 1; int64 value = 2; }
  const counters = [];
  for (const field of decodeFields(payload)) {
    if (field.fieldNumber !== 1 || field.wireType !== 2) continue;
    let name = null;
    let value = 0;
    for (const inner of decodeFields(field.value)) {
      if (inner.fieldNumber === 1 && inner.wireType === 2) name = inner.value.toString('utf8');
      else if (inner.fieldNumber === 2 && inner.wireType === 0) value = int64FromVarint(inner.value);
    }
    if (typeof name !== 'string' || name.length === 0 || name.length > 256 || value < 0) continue;
    counters.push({ name, value });
    if (counters.length > MAX_COUNTERS) throw new RangeError('too many traffic counters');
  }
  return counters;
}

/** Map a sing-box user counter to its gateway user, optional exit and direction. */
export function parseUserCounter(name) {
  const match = typeof name === 'string' ? USER_COUNTER.exec(name) : null;
  if (!match) return null;
  return { userId: match[1], exitId: match[2] ?? null, direction: match[3] };
}
