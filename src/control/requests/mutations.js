import { verifySubscriptionToken } from '../../core/identity/credentials.js';
import { ControllerError, exactObject, stringField, credentialMutationFingerprint } from './contract.js';
import { credentialResult } from '../authority/state-views.js';
import { mutateUser } from './users.js';
import { mutateGateway } from './gateway.js';

/** A cached one-time result may be replayed only while every secret in it still authenticates. */
async function replayStillValid(controller, user, cached) {
  if (user?.status !== 'active') return false;
  if (!verifySubscriptionToken(cached.rawToken, user.tokenHash)) return false;
  if (cached.rawPassword === undefined) return true;
  return Object.hasOwn(user, 'password') && controller.verifyPassword(cached.rawPassword, user.password);
}

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
      const cached = replay.result ?? {};
      const replayUser = replayState.state.users.find((user) => user.id === cached.user?.id);
      if (await replayStillValid(controller, replayUser, cached)) {
        const currentCsrf = controller.sessions.currentCsrf(request.sessionId);
        if (!currentCsrf) throw new ControllerError('UNAUTHORIZED', 401);
        return credentialResult(
          replayState.state,
          replayUser,
          cached.rawToken,
          currentCsrf,
          cached.rawPassword ?? null,
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
