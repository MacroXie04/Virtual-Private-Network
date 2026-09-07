import { LifecycleError } from '../core/lifecycle.js';
import { RepositoryError } from '../state/repository-policy.js';
import { ValidationError } from '../core/validation.js';

export class ControllerError extends Error {
  constructor(code, status = 500, message = 'Controller operation failed') {
    super(message);
    this.name = 'ControllerError';
    this.code = code;
    this.status = status;
  }
}

export function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControllerError('INVALID', 400);
  }
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new ControllerError('INVALID', 400);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new ControllerError('INVALID', 400);
  }
  return value;
}

export function stringField(value, { min = 1, max = 4096, pattern = null } = {}) {
  if (
    typeof value !== 'string'
    || value.length < min
    || value.length > max
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || (pattern && !pattern.test(value))
  ) throw new ControllerError('INVALID', 400);
  return value;
}

export function revisionField(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ControllerError('INVALID', 400);
  return value;
}

export function credentialMutationFingerprint(request, operation) {
  if (operation === 'user.create') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'displayName']);
    return JSON.stringify([
      operation,
      request.csrf,
      request.expectedRevision,
      request.displayName,
    ]);
  }
  if (operation === 'user.rotateToken' || operation === 'user.rotateCredentials') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId']);
    return JSON.stringify([
      operation,
      request.csrf,
      request.expectedRevision,
      request.userId,
    ]);
  }
  return null;
}

export function operationError(error) {
  if (error instanceof ControllerError) return error;
  if (error instanceof LifecycleError) {
    return new ControllerError(error.code, error.status ?? 409);
  }
  if (error instanceof ValidationError) return new ControllerError('INVALID', 400);
  if (error instanceof RepositoryError) return new ControllerError('STATE_UNAVAILABLE', 503);
  return new ControllerError('INTERNAL', 500);
}
