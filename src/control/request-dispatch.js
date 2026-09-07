import { getUser } from '../core/lifecycle.js';
import { renderVlessLink } from '../core/client-subscriptions.js';
import { ControllerError, exactObject, stringField, operationError } from './request-contract.js';
import { hasEnrollmentCredentials } from './state-views.js';
import { dispatchMutation } from './operations/mutations.js';

export async function dispatch(controller, request) {
  try {
    exactObject(request, ['id', 'op', 'secret', 'sessionId', 'csrf', 'expectedRevision', 'displayName', 'userId', 'status', 'confirmName', 'deviceId', 'exitId', 'url'], ['id', 'op']);
    stringField(request.id, { min: 1, max: 64, pattern: /^[A-Za-z0-9-]+$/u });
    const op = stringField(request.op, { min: 3, max: 32, pattern: /^[a-z][a-zA-Z.]+$/u });
    if (op === 'health.status') {
      exactObject(request, ['id', 'op']);
      return await controller.queueMutation(async () => {
        let current = await controller.state();
        const runtimeId = await controller.repository.readPointer('runtime');
        if (
          !controller.ready
          || runtimeId !== current.id
          || hasEnrollmentCredentials(current.state)
        ) {
          try {
            current = await controller.recover();
          } catch {
            controller.ready = false;
            await controller.setMaintenance(true).catch(() => {});
            throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
          }
          return { status: 'ok', revision: current.state.revision };
        }
        try {
          await controller.runtime.probe({ timeoutMs: 3_000, attemptTimeoutMs: 2_500, intervalMs: 100 });
        } catch {
          controller.ready = false;
          await controller.setMaintenance(true).catch(() => {});
          throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
        }
        return { status: 'ok', revision: current.state.revision };
      });
    }
    if (op === 'auth.login') {
      exactObject(request, ['id', 'op', 'secret']);
      return await controller.login(stringField(request.secret, { min: 1, max: 1024 }));
    }
    if (op === 'auth.check') {
      exactObject(request, ['id', 'op', 'sessionId']);
      controller.session(stringField(request.sessionId, { min: 16, max: 512 }));
      return {};
    }
    if (op === 'admin.snapshot') {
      exactObject(request, ['id', 'op', 'sessionId']);
      return await controller.snapshot(stringField(request.sessionId, { min: 16, max: 512 }));
    }
    if (op === 'user.export') {
      exactObject(request, ['id', 'op', 'sessionId', 'userId']);
      controller.session(stringField(request.sessionId, { min: 16, max: 512 }));
      const current = await controller.state();
      const user = getUser(current.state, stringField(request.userId, { min: 3, max: 64 }));
      if (user.status !== 'active') throw new ControllerError('USER_NOT_FOUND', 404);
      return { vlessLink: renderVlessLink(current.state, user.id) };
    }

    return await controller.queueMutation(() => dispatchMutation(controller, request));
  } catch (error) {
    throw operationError(error);
  }
}
