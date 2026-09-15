import { createHash } from 'node:crypto';
import { isPlainObject } from '../../core/validation/values.js';
import { RepositoryError } from '../filesystem/policy.js';

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseJson(bytes, description) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new RepositoryError('INVALID_REVISION', `${description} is not valid JSON`);
  }
}

export function validateManifest(value, expectedRevision) {
  if (!isPlainObject(value)) throw new RepositoryError('INVALID_REVISION', 'manifest is invalid');
  const keys = ['schemaVersion', 'revision', 'operation', 'createdAt', 'files'];
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new RepositoryError('INVALID_REVISION', 'manifest is invalid');
  }
  if (value.schemaVersion !== 1 || value.revision !== expectedRevision) {
    throw new RepositoryError('INVALID_REVISION', 'manifest revision does not match');
  }
  if (typeof value.operation !== 'string' || !/^[a-z][a-z0-9.-]{0,31}$/u.test(value.operation)) {
    throw new RepositoryError('INVALID_REVISION', 'manifest operation is invalid');
  }
  if (typeof value.createdAt !== 'string') throw new RepositoryError('INVALID_REVISION', 'manifest timestamp is invalid');
  if (!isPlainObject(value.files)) throw new RepositoryError('INVALID_REVISION', 'manifest files are invalid');
  const names = ['state.json', 'sing-box.json', 'subscription-view.json'];
  if (Object.keys(value.files).length !== names.length || !names.every((name) => Object.hasOwn(value.files, name))) {
    throw new RepositoryError('INVALID_REVISION', 'manifest files are invalid');
  }
  for (const name of names) {
    const record = value.files[name];
    if (!isPlainObject(record)
      || Object.keys(record).length !== 2
      || !/^[0-9a-f]{64}$/u.test(record.sha256)
      || !Number.isSafeInteger(record.size)
      || record.size < 2) {
      throw new RepositoryError('INVALID_REVISION', 'manifest file record is invalid');
    }
  }
  return value;
}

export function manifestRecord(bytes) {
  return { sha256: digest(bytes), size: bytes.length };
}
