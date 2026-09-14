import { createUser, disableUser, enableUser, getUser, renameUser, revokeUser } from '../../core/users/lifecycle.js';
import { rotateSubscriptionToken, rotateUserCredentials, setUserPassword } from '../../core/users/credential-rotation.js';
import { createAdminScryptRecord, createUserPassword } from '../../core/identity/credentials.js';
import { normalizeDisplayName } from '../../core/validation/values.js';
import { ControllerError, exactObject, stringField } from './contract.js';
import { revokeAccountSessions } from '../authority/accounts.js';
import { credentialResult, safeUser } from '../authority/state-views.js';

/** Apply an already-authorized user mutation inside the controller queue. */
export async function mutateUser(controller, request, context) {
  const { current, authorized, credentialFingerprint } = context;
  const op = request.op;
  const mutationOptions = { now: controller.now };
  if (op === 'user.create') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'displayName']);
    // Derive the portal password before the synchronous lifecycle step; it is shown once with the token.
    const rawPassword = createUserPassword();
    const password = await createAdminScryptRecord(rawPassword);
    const changed = createUser(current.state, { displayName: request.displayName, password }, mutationOptions);
    await controller.transact(changed.state, { operation: 'user.create', userId: changed.user.id });
    const nextCsrf = controller.commitMutationSession(authorized);
    const result = credentialResult(changed.state, changed.user, changed.token, nextCsrf, rawPassword);
    controller.sessions.rememberReplay?.(authorized, request.id, credentialFingerprint, result);
    return result;
  }
  if (op === 'user.setStatus') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId', 'status']);
    const userId = stringField(request.userId, { min: 3, max: 64 });
    const changed = request.status === 'active'
      ? enableUser(current.state, userId, mutationOptions)
      : request.status === 'disabled'
        ? disableUser(current.state, userId, mutationOptions)
        : (() => { throw new ControllerError('INVALID', 400); })();
    await controller.transact(changed.state, { operation: `user.${request.status}`, userId });
    if (request.status === 'disabled') revokeAccountSessions(controller, userId);
    return {
      user: safeUser(changed.user),
      revision: changed.state.revision,
      csrf: controller.commitMutationSession(authorized),
    };
  }
  if (op === 'user.rename') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId', 'displayName']);
    const userId = stringField(request.userId, { min: 3, max: 64 });
    const changed = renameUser(current.state, userId, request.displayName, mutationOptions);
    // Display names appear only in subscriptions and links, never in the data plane.
    await controller.transact(changed.state, { operation: 'user.rename', userId, restart: false });
    return {
      user: safeUser(changed.user),
      revision: changed.state.revision,
      csrf: controller.commitMutationSession(authorized),
    };
  }
  if (op === 'user.revoke') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId', 'confirmName']);
    const userId = stringField(request.userId, { min: 3, max: 64 });
    const user = getUser(current.state, userId);
    if (normalizeDisplayName(request.confirmName, 'confirmName') !== user.displayName) {
      throw new ControllerError('CONFIRMATION_MISMATCH', 400);
    }
    const changed = revokeUser(current.state, userId, mutationOptions);
    await controller.transact(changed.state, { operation: 'user.revoke', userId });
    revokeAccountSessions(controller, userId);
    return {
      user: safeUser(changed.user),
      revision: changed.state.revision,
      csrf: controller.commitMutationSession(authorized),
    };
  }
  if (op === 'user.rotateToken') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId']);
    const userId = stringField(request.userId, { min: 3, max: 64 });
    const changed = rotateSubscriptionToken(current.state, userId, mutationOptions);
    await controller.transact(changed.state, { operation: 'user.rotate-token', userId, restart: false });
    const nextCsrf = controller.commitMutationSession(authorized);
    const result = credentialResult(changed.state, changed.user, changed.token, nextCsrf);
    controller.sessions.rememberReplay?.(authorized, request.id, credentialFingerprint, result);
    return result;
  }
  if (op === 'user.rotateCredentials') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId']);
    const userId = stringField(request.userId, { min: 3, max: 64 });
    const changed = rotateUserCredentials(current.state, userId, mutationOptions);
    await controller.transact(changed.state, { operation: 'user.rotate-all', userId });
    revokeAccountSessions(controller, userId);
    const nextCsrf = controller.commitMutationSession(authorized);
    const result = credentialResult(changed.state, changed.user, changed.token, nextCsrf);
    controller.sessions.rememberReplay?.(authorized, request.id, credentialFingerprint, result);
    return result;
  }

  if (op === 'user.resetPassword') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId']);
    const userId = stringField(request.userId, { min: 3, max: 64 });
    const rawPassword = createUserPassword();
    const record = await createAdminScryptRecord(rawPassword);
    const changed = setUserPassword(current.state, userId, record, mutationOptions);
    await controller.transact(changed.state, { operation: 'user.reset-password', userId, restart: false });
    revokeAccountSessions(controller, userId);
    return {
      user: safeUser(changed.user),
      rawPassword,
      revision: changed.state.revision,
      csrf: controller.commitMutationSession(authorized),
    };
  }

  throw new ControllerError('UNKNOWN_OPERATION', 400);
}
