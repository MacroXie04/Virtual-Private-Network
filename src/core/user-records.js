import {
  ValidationError,
  expectExactKeys,
  expectString,
  normalizeDisplayName,
  validateTimestamp,
  validateTokenHash,
  validateUuid,
} from './validation.js';

const USER_STATUSES = new Set(['active', 'disabled', 'revoked']);

function nullableTimestamp(value, path) {
  return value === null ? null : validateTimestamp(value, path);
}

export function validateUserId(value, path) {
  const id = expectString(value, path, { min: 3, max: 64 });
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(id)) {
    throw new ValidationError(path, 'must contain only lowercase letters, digits, underscores, and hyphens');
  }
  return id;
}

export function validateUser(value, path) {
  const user = expectExactKeys(value, [
    'id',
    'displayName',
    'uuid',
    'tokenHash',
    'status',
    'createdAt',
    'updatedAt',
    'disabledAt',
    'revokedAt',
  ], path);
  const status = expectString(user.status, `${path}.status`, { min: 6, max: 8 });
  if (!USER_STATUSES.has(status)) {
    throw new ValidationError(`${path}.status`, 'must be active, disabled, or revoked');
  }
  const createdAt = validateTimestamp(user.createdAt, `${path}.createdAt`);
  const updatedAt = validateTimestamp(user.updatedAt, `${path}.updatedAt`);
  const disabledAt = nullableTimestamp(user.disabledAt, `${path}.disabledAt`);
  const revokedAt = nullableTimestamp(user.revokedAt, `${path}.revokedAt`);
  if (updatedAt < createdAt) throw new ValidationError(`${path}.updatedAt`, 'must not precede createdAt');
  if (disabledAt !== null && disabledAt < createdAt) {
    throw new ValidationError(`${path}.disabledAt`, 'must not precede createdAt');
  }
  if (disabledAt !== null && disabledAt > updatedAt) {
    throw new ValidationError(`${path}.disabledAt`, 'must not follow updatedAt');
  }
  if (revokedAt !== null && revokedAt < createdAt) {
    throw new ValidationError(`${path}.revokedAt`, 'must not precede createdAt');
  }
  if (revokedAt !== null && revokedAt > updatedAt) {
    throw new ValidationError(`${path}.revokedAt`, 'must not follow updatedAt');
  }
  if (status === 'active' && (disabledAt !== null || revokedAt !== null)) {
    throw new ValidationError(path, 'active users cannot have disabledAt or revokedAt timestamps');
  }
  if (status === 'disabled' && (disabledAt === null || revokedAt !== null)) {
    throw new ValidationError(path, 'disabled users require disabledAt and cannot have revokedAt');
  }
  if (status === 'revoked' && revokedAt === null) {
    throw new ValidationError(path, 'revoked users require revokedAt');
  }
  return {
    id: validateUserId(user.id, `${path}.id`),
    displayName: normalizeDisplayName(user.displayName, `${path}.displayName`),
    uuid: validateUuid(user.uuid, `${path}.uuid`),
    tokenHash: validateTokenHash(user.tokenHash, `${path}.tokenHash`),
    status,
    createdAt,
    updatedAt,
    disabledAt,
    revokedAt,
  };
}

export function assertUniqueUsers(users) {
  const properties = [
    ['id', (user) => user.id],
    ['uuid', (user) => user.uuid],
    ['tokenHash', (user) => user.tokenHash],
  ];
  for (const [name, getter] of properties) {
    const seen = new Set();
    users.forEach((user, index) => {
      const value = getter(user);
      if (seen.has(value)) throw new ValidationError(`state.users[${index}].${name}`, 'must be unique');
      seen.add(value);
    });
  }
  const activeNames = new Set();
  users.forEach((user, index) => {
    if (user.status === 'revoked') return;
    const key = user.displayName.toLowerCase();
    if (activeNames.has(key)) {
      throw new ValidationError(`state.users[${index}].displayName`, 'must be unique among non-revoked users');
    }
    activeNames.add(key);
  });
}

export function validateProjectedUser(value, path) {
  const user = expectExactKeys(value, ['id', 'displayName', 'uuid', 'tokenHash'], path);
  return {
    id: validateUserId(user.id, `${path}.id`),
    displayName: normalizeDisplayName(user.displayName, `${path}.displayName`),
    uuid: validateUuid(user.uuid, `${path}.uuid`),
    tokenHash: validateTokenHash(user.tokenHash, `${path}.tokenHash`),
  };
}
