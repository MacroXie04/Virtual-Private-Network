import { verifySubscriptionToken } from '../../core/identity/credentials.js';
import { ControllerError, exactObject, stringField, credentialMutationFingerprint } from './contract.js';
import { mutateUser } from './users.js';
import { mutateGateway } from './gateway.js';

/** Preserve serialization, exact replay, CSRF and revision authority for writes. */
export async function dispatchMutation(controller, request) {
  const op = request.op;
  if (op === 'auth.logout') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf']);
    const sessionId = stringField(request.sessionId, { min: 16, max: 512 });
    controller.mutationSession(sessionId, stringField(request.csrf, { min: 1, max: 512 }));
    controller.sessions.destroy(sessionId);
    return {};
  }

  await controller.assertOuterTransactionCommitted();

  const credentialFingerprint = credentialMutationFingerprint(request, op);
  if (credentialFingerprint !== null) {
    const replay = controller.sessions.lookupReplay?.(
      stringField(request.sessionId, { min: 16, max: 512 }),
      request.id,
      credentialFingerprint,
    );
    if (replay?.status === 'match') {
      // Another administrator may have committed an unrelated revision
      // between a lost response and its retry. Rebuild the non-secret
      // fields from current authority and return the cached token only
      // while it still authenticates the same active user. This keeps
      // delivery reliable without ever replaying superseded credentials.
      const replayState = await controller.state();
      const replayUser = replayState.state.users.find(
        (user) => user.id === replay.result?.user?.id,
      );
      if (
        replayUser?.status === 'active'
        && verifySubscriptionToken(replay.result?.rawToken, replayUser.tokenHash)
      ) {
        const currentCsrf = controller.sessions.currentCsrf(request.sessionId);
        if (!currentCsrf) throw new ControllerError('UNAUTHORIZED', 401);
        return controller.credentialResult(
          replayState.state,
          replayUser,
          replay.result.rawToken,
          currentCsrf,
        );
      }
      controller.sessions.forgetReplay?.(request.sessionId, request.id);
      throw new ControllerError('IDEMPOTENCY_STALE', 409);
    }
    if (replay?.status === 'conflict') {
      throw new ControllerError('IDEMPOTENCY_CONFLICT', 409);
    }
  }

  // A failed persisted exit node must not make the repair interface
  // disappear. In degraded mode allow a validated default selection or
  // removal of a failed extra exit. Both must prove the remaining routes
  // before maintenance is cleared.
  if (!controller.ready && op !== 'exit.select' && op !== 'exit.remove') {
    throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
  }

  const sessionId = stringField(request.sessionId, { min: 16, max: 512 });
  const authorized = controller.mutationSession(
    sessionId,
    stringField(request.csrf, { min: 1, max: 512 }),
  );
  const current = await controller.state();
  controller.assertRevision(current, request.expectedRevision);

  const context = { current, authorized, credentialFingerprint };
  return op.startsWith('user.')
    ? mutateUser(controller, request, context)
    : mutateGateway(controller, request, context);
}
