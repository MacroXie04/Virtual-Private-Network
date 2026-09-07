import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readBoundedFileNoFollow } from '../state/bootstrap-files.js';
import { isPlainObject } from '../core/validation.js';
import { MigrationError } from './migration-errors.js';

const MIGRATION_REVISION_ID = /^[0-9]{16}-[0-9a-f]{16}$/u;
export const MIGRATION_DIGEST = /^[0-9a-f]{64}$/u;

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function migrationLineageError(message) {
  return new MigrationError('INVALID_MIGRATION_LINEAGE', message);
}

function migrationInvariantDigest(state) {
  return digest(Buffer.from(JSON.stringify({
    schemaVersion: state.schemaVersion,
    createdAt: state.createdAt,
    gateway: state.gateway,
    tailscale: {
      hostname: state.tailscale.hostname,
      stateDirectory: state.tailscale.stateDirectory,
      exitNode: state.tailscale.exitNode,
    },
    health: state.health,
    admin: state.admin,
    users: state.users,
  }), 'utf8'));
}

function initialStateBytes(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function migrationLineageRecord(state) {
  const bytes = initialStateBytes(state);
  return {
    schemaVersion: 1,
    source: 'legacy-v1',
    initialRevisionId: `${String(state.revision).padStart(16, '0')}-${digest(bytes).slice(0, 16)}`,
    initialRevision: 1,
    initialStateSha256: digest(bytes),
    invariantSha256: migrationInvariantDigest(state),
  };
}

export function parseMigrationLineage(bytes) {
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw migrationLineageError('legacy migration lineage record is not valid JSON');
  }
  const keys = [
    'schemaVersion',
    'source',
    'initialRevisionId',
    'initialRevision',
    'initialStateSha256',
    'invariantSha256',
  ];
  if (!isPlainObject(record)
      || Object.keys(record).length !== keys.length
      || !keys.every((key) => Object.hasOwn(record, key))
      || record.schemaVersion !== 1
      || record.source !== 'legacy-v1'
      || record.initialRevision !== 1
      || !MIGRATION_REVISION_ID.test(record.initialRevisionId)
      || !MIGRATION_DIGEST.test(record.initialStateSha256)
      || !MIGRATION_DIGEST.test(record.invariantSha256)) {
    throw migrationLineageError('legacy migration lineage record is invalid');
  }
  return record;
}

export function assertMigrationLineageMatches(lineage, expected) {
  if (!isDeepStrictEqual(lineage, expected)) {
    throw migrationLineageError('legacy migration lineage does not match the reviewed initial revision');
  }
}

export async function readMigrationLineage(lineagePath) {
  return parseMigrationLineage(await readBoundedFileNoFollow(lineagePath, {
    maxBytes: 1024,
    requirePrivate: true,
    description: 'legacy migration lineage record',
  }));
}
