import { DEFAULT_SCRYPT_PARAMETERS, validateScryptRecord } from '../../core/identity/credentials.js';
import { findUserBySignInName } from '../../core/users/lifecycle.js';
import { ControllerError } from '../requests/contract.js';
import { ControllerSessions } from './sessions.js';

/** End-user sessions live in their own bounded store so portal sign-ins never evict an administrator. */
export const ACCOUNT_SESSION_OPTIONS = Object.freeze({
  idleTimeoutMs: 60 * 60 * 1000,
  absoluteTimeoutMs: 24 * 60 * 60 * 1000,
  maxSessions: 512,
});

const MAX_SESSIONS_PER_USER = 8;
/** Every portal change is a full fail-closed transaction, so the budget follows the user, not the session. */
export const ACCOUNT_MUTATION_BUDGET = Object.freeze({ limit: 6, windowMs: 10 * 60 * 1000 });

export function createAccountSessions(overrides = {}) {
  return new ControllerSessions({ ...ACCOUNT_SESSION_OPTIONS, ...overrides });
}

/** A user's own sign-ins displace only their least recently used session, never another user's. */
function capUserSessions(store, userId) {
  const own = [...store.sessions].filter(([, session]) => session.subject === userId).map(([key]) => key);
  while (own.length >= MAX_SESSIONS_PER_USER) store.sessions.delete(own.shift());
}

export function takeAccountBudget(controller, userId) {
  const now = new Date(controller.now()).getTime();
  for (const [key, entry] of controller.accountBudget) {
    if (entry.resetAt <= now) controller.accountBudget.delete(key);
  }
  const entry = controller.accountBudget.get(userId);
  if (!entry) {
    controller.accountBudget.set(userId, { count: 1, resetAt: now + ACCOUNT_MUTATION_BUDGET.windowMs });
    return;
  }
  if (entry.count >= ACCOUNT_MUTATION_BUDGET.limit) throw new ControllerError('RATE_LIMITED', 429);
  entry.count += 1;
}

// A structurally valid record makes a sign-in for an unknown or passwordless
// name pay one full derivation; an invalid record would return instantly and
// reveal which display names exist.
export const DUMMY_SCRYPT_RECORD = Object.freeze(validateScryptRecord({
  algorithm: 'scrypt',
  salt: Buffer.alloc(16).toString('base64url'),
  hash: Buffer.alloc(DEFAULT_SCRYPT_PARAMETERS.keyLength).toString('base64url'),
  ...DEFAULT_SCRYPT_PARAMETERS,
}));

function failureDelay(controller) {
  return new Promise((resolve) => {
    const timer = controller.setLoginTimeout(resolve, controller.loginFailureDelayMs);
    timer?.unref?.();
  });
}

function unauthorized() {
  return new ControllerError('UNAUTHORIZED', 401);
}

function canSignIn(user) {
  return user !== null && user.status === 'active' && Object.hasOwn(user, 'password');
}

/** Administrator sign-in: only the derivation holds the shared login tail; the failure delay does not. */
export async function adminLogin(controller, secret) {
  const valid = await controller.queueLogin(async () => {
    const current = await controller.state();
    return controller.verifyPassword(secret, current.state.admin.scrypt);
  });
  if (!valid) {
    await failureDelay(controller);
    throw unauthorized();
  }
  // Session issuance can evict the oldest bounded session. Serialize that
  // small step with mutations so an authenticated in-flight mutation cannot
  // commit and then lose its session before its post-commit CSRF rotation.
  return controller.queueMutation(() => controller.sessions.issue());
}

/** End-user sign-in by display name; every failure class costs one derivation and yields one code. */
export async function accountLogin(controller, displayName, password) {
  const user = await controller.queueLogin(async () => {
    const current = await controller.state();
    const candidate = findUserBySignInName(current.state, displayName);
    const record = canSignIn(candidate) ? candidate.password : DUMMY_SCRYPT_RECORD;
    const verified = await controller.verifyPassword(password, record);
    return verified && record !== DUMMY_SCRYPT_RECORD ? candidate : null;
  });
  if (user === null) {
    await failureDelay(controller);
    throw unauthorized();
  }
  return controller.queueMutation(() => {
    capUserSessions(controller.accountSessions, user.id);
    return controller.accountSessions.issue(1, user.id);
  });
}

export function accountSession(controller, sessionId) {
  const found = controller.accountSessions.get(sessionId);
  if (!found) throw unauthorized();
  return found;
}

export function accountMutationSession(controller, sessionId, csrf) {
  const found = controller.accountSessions.verifyMutation(sessionId, csrf);
  if (!found) throw new ControllerError('FORBIDDEN', 403);
  return found;
}

export function commitAccountMutation(controller, verified) {
  const rotated = controller.accountSessions.rotateMutation(verified);
  if (!rotated) throw unauthorized();
  return rotated.csrf;
}

/** Bind a live session to current state: the user must still exist, be active and hold a password. */
export function accountSubject(controller, current, sessionId, found) {
  const user = current.state.users.find((entry) => entry.id === found.session.subject) ?? null;
  if (!canSignIn(user)) {
    controller.accountSessions.destroy(sessionId);
    throw unauthorized();
  }
  return user;
}

export function revokeAccountSessions(controller, userId, exceptKey = null) {
  return controller.accountSessions.destroySubject(userId, exceptKey);
}
