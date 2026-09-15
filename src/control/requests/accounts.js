import { createAdminScryptRecord } from '../../core/identity/credentials.js';
import { renderClientSubscription } from '../../core/subscriptions/clients.js';
import { rotateSubscriptionToken, setUserPassword } from '../../core/users/credential-rotation.js';
import {
  accountLogin,
  accountMutationSession,
  accountSession,
  accountSubject,
  commitAccountMutation,
  revokeAccountSessions,
  takeAccountBudget,
} from '../authority/accounts.js';
import { accountSnapshot, credentialResult } from '../authority/state-views.js';
import { ControllerError, exactObject, stringField } from './contract.js';

const SESSION_ID = { min: 16, max: 512 };
const PASSWORD = { min: 1, max: 1024 };

/** Resolve a session to its user against current state; the request never names the user. */
async function boundSession(controller, sessionId) {
  const found = accountSession(controller, sessionId);
  const current = await controller.state();
  return { found, current, user: accountSubject(controller, current, sessionId, found) };
}

/** End-user operations: reads inline, everything else through the serialized mutation queue. */
export async function dispatchAccount(controller, request) {
  const op = request.op;
  if (op === 'account.login') {
    exactObject(request, ['id', 'op', 'displayName', 'password']);
    return accountLogin(
      controller,
      stringField(request.displayName, { min: 1, max: 128 }),
      stringField(request.password, PASSWORD),
    );
  }
  if (op === 'account.check') {
    exactObject(request, ['id', 'op', 'sessionId']);
    // In-memory gate only; every data-bearing operation re-binds the session to current state.
    accountSession(controller, stringField(request.sessionId, SESSION_ID));
    return {};
  }
  if (op === 'account.snapshot') {
    exactObject(request, ['id', 'op', 'sessionId']);
    const sessionId = stringField(request.sessionId, SESSION_ID);
    const { current, user } = await boundSession(controller, sessionId);
    return accountSnapshot(controller, current, user, sessionId);
  }
  if (op === 'account.export') {
    exactObject(request, ['id', 'op', 'sessionId', 'format']);
    const format = stringField(request.format, { min: 5, max: 8, pattern: /^(?:links|sing-box|clash)$/u });
    const { current, user } = await boundSession(controller, stringField(request.sessionId, SESSION_ID));
    return { format, body: renderClientSubscription(current.state, user.id, format) };
  }
  return controller.queueMutation(() => mutateAccount(controller, request));
}

async function mutateAccount(controller, request) {
  const op = request.op;
  const sessionId = stringField(request.sessionId, SESSION_ID);
  const csrf = stringField(request.csrf, { min: 1, max: 512 });
  if (op === 'account.logout') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf']);
    accountMutationSession(controller, sessionId, csrf);
    controller.accountSessions.destroy(sessionId);
    return {};
  }

  await controller.assertOuterTransactionCommitted();
  if (!controller.ready) throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
  const authorized = accountMutationSession(controller, sessionId, csrf);
  const current = await controller.state();
  const user = accountSubject(controller, current, sessionId, authorized);
  takeAccountBudget(controller, user.id);
  const mutationOptions = { now: controller.now };

  if (op === 'account.rotateToken') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf']);
    const changed = rotateSubscriptionToken(current.state, user.id, mutationOptions);
    // Only the subscription credential moves; the UUID stays, so the data plane keeps running.
    await controller.transact(changed.state, { operation: 'account.rotate-token', userId: user.id, restart: false });
    const nextCsrf = commitAccountMutation(controller, authorized);
    return credentialResult(changed.state, changed.user, changed.token, nextCsrf);
  }
  if (op === 'account.changePassword') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'currentPassword', 'newPassword']);
    const currentPassword = stringField(request.currentPassword, PASSWORD);
    const newPassword = stringField(request.newPassword, PASSWORD);
    // A wrong current password is a form error, never a lost session.
    if (!(await controller.verifyPassword(currentPassword, user.password))) {
      throw new ControllerError('PASSWORD_MISMATCH', 400);
    }
    if (newPassword === currentPassword) throw new ControllerError('PASSWORD_UNCHANGED', 400);
    const record = await createAdminScryptRecord(newPassword);
    const changed = setUserPassword(current.state, user.id, record, mutationOptions);
    await controller.transact(changed.state, { operation: 'account.password', userId: user.id, restart: false });
    // Other devices sign in again with the new password; this session keeps working.
    revokeAccountSessions(controller, user.id, authorized.key);
    return { csrf: commitAccountMutation(controller, authorized) };
  }
  throw new ControllerError('UNKNOWN_OPERATION', 400);
}
