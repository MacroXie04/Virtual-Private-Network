import {
  createUser, disableUser, enableUser, getUser, revokeUser,
  rotateSubscriptionToken, rotateUserCredentials,
} from '../../core/lifecycle.js';
import { normalizeDisplayName } from '../../core/validation.js';
import { ControllerError, exactObject, stringField } from '../request-contract.js';
import { safeUser } from '../state-views.js';

/** Apply an already-authorized user mutation inside the controller queue. */
export async function mutateUser(controller, request, context) {
  const { current, authorized, credentialFingerprint } = context;
  const op = request.op;
  const mutationOptions = { now: controller.now };
  if (op === 'user.create') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'displayName']);
    const changed = createUser(current.state, { displayName: request.displayName }, mutationOptions);
    await controller.transact(changed.state, { operation: 'user.create', userId: changed.user.id });
    const nextCsrf = controller.commitMutationSession(authorized);
    const result = controller.credentialResult(changed.state, changed.user, changed.token, nextCsrf);
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
    const result = controller.credentialResult(changed.state, changed.user, changed.token, nextCsrf);
    controller.sessions.rememberReplay?.(authorized, request.id, credentialFingerprint, result);
    return result;
  }
  if (op === 'user.rotateCredentials') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId']);
    const userId = stringField(request.userId, { min: 3, max: 64 });
    const changed = rotateUserCredentials(current.state, userId, mutationOptions);
    await controller.transact(changed.state, { operation: 'user.rotate-all', userId });
    const nextCsrf = controller.commitMutationSession(authorized);
    const result = controller.credentialResult(changed.state, changed.user, changed.token, nextCsrf);
    controller.sessions.rememberReplay?.(authorized, request.id, credentialFingerprint, result);
    return result;
  }

  throw new ControllerError('UNKNOWN_OPERATION', 400);
}
