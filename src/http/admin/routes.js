import { ControlError } from '../../control/socket/client-transport.js';
import { HttpError, readForm } from '../shared/input.js';
import { sendGenericError, sendResponse } from '../shared/service.js';
import { renderDashboardPage } from './pages/dashboard.js';
import { renderSecretPage } from './pages/access.js';
import { html, redirect } from './auth.js';
import { exactForm, valueOnce, operationIdFrom, revisionFrom, sessionRateKey } from './request.js';

const IDENTIFIER = '[A-Za-z0-9_-]{1,128}';
const USER_STATUS_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/status$`, 'u');
const USER_REVOKE_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/revoke$`, 'u');
const USER_ROTATE_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/rotate-token$`, 'u');
const USER_ROTATE_CREDENTIALS_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/rotate-credentials$`, 'u');
const USER_EXPORT_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/export$`, 'u');
const EXIT_REMOVE_ROUTE = /^\/exit-nodes\/([0-9a-f]{16})\/remove$/u;

export function createAdminRoutes({ control, mutationRateLimiter, access }) {
  const { sendControllerError, clearSession } = access;
  return async (req, res, url, sessionId) => {
    const authenticatedRateKey = sessionRateKey(sessionId);
    const readRequestForm = () => readForm(req, { maxBytes: 16 * 1024, timeoutMs: 5_000 });
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/') {
      try {
        const snapshot = await control.snapshot(sessionId);
        if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.csrf !== 'string') {
          throw new ControlError('INTERNAL', 500);
        }
        html(req, res, 200, renderDashboardPage(snapshot));
      } catch (error) {
        sendControllerError(req, res, error);
      }
      return;
    }

    const exportRoute = USER_EXPORT_ROUTE.exec(url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && exportRoute) {
      try {
        const result = await control.exportUser(sessionId, exportRoute[1]);
        const link = typeof result === 'string' ? result : result?.vlessLink;
        if (typeof link !== 'string' || !link.startsWith('vless://') || link.length > 8192) {
          throw new ControlError('INTERNAL', 500);
        }
        sendResponse(req, res, 200, `${link}\n`, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="vless-link.txt"',
        });
      } catch (error) {
        sendControllerError(req, res, error);
      }
      return;
    }

    if (req.method !== 'POST') {
      sendGenericError(req, res, 404);
      return;
    }

    const mutationRate = mutationRateLimiter.take(authenticatedRateKey);
    if (!mutationRate.allowed) {
      sendResponse(req, res, 429, 'Too Many Requests\n', {
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': String(mutationRate.retryAfter),
      });
      return;
    }

    let form;
    try {
      form = await readRequestForm();
    } catch (error) {
      sendGenericError(req, res, error instanceof HttpError ? error.status : 400);
      return;
    }

    let csrf;
    try {
      csrf = valueOnce(form, 'csrf', { min: 1, max: 512 });
    } catch (error) {
      sendGenericError(req, res, error.status);
      return;
    }

    try {
      if (url.pathname === '/logout') {
        exactForm(form, ['csrf']);
        await control.logout(sessionId, csrf);
        redirect(req, res, '/login', { 'set-cookie': clearSession });
        return;
      }

      const expectedRevision = revisionFrom(form);
      if (url.pathname === '/users') {
        exactForm(form, ['csrf', 'expectedRevision', 'displayName', 'operationId']);
        const displayName = valueOnce(form, 'displayName', { max: 128 });
        const operationId = operationIdFrom(form);
        const result = await control.createUser(
          sessionId,
          csrf,
          expectedRevision,
          displayName,
          operationId,
        );
        html(req, res, 201, renderSecretPage(result, { heading: 'User created' }));
        return;
      }
      const statusRoute = USER_STATUS_ROUTE.exec(url.pathname);
      if (statusRoute) {
        exactForm(form, ['csrf', 'expectedRevision', 'status']);
        const status = valueOnce(form, 'status', { max: 8 });
        if (status !== 'active' && status !== 'disabled') throw new HttpError(400);
        await control.setUserStatus(sessionId, csrf, expectedRevision, statusRoute[1], status);
        redirect(req, res, '/');
        return;
      }
      const revokeRoute = USER_REVOKE_ROUTE.exec(url.pathname);
      if (revokeRoute) {
        exactForm(form, ['csrf', 'expectedRevision', 'confirmName']);
        const confirmName = valueOnce(form, 'confirmName', { max: 128 });
        await control.revokeUser(sessionId, csrf, expectedRevision, revokeRoute[1], confirmName);
        redirect(req, res, '/');
        return;
      }
      const rotateRoute = USER_ROTATE_ROUTE.exec(url.pathname);
      if (rotateRoute) {
        exactForm(form, ['csrf', 'expectedRevision', 'operationId']);
        const operationId = operationIdFrom(form);
        const result = await control.rotateUserToken(
          sessionId,
          csrf,
          expectedRevision,
          rotateRoute[1],
          operationId,
        );
        html(req, res, 200, renderSecretPage(result, { heading: 'Subscription token rotated' }));
        return;
      }
      const rotateCredentialsRoute = USER_ROTATE_CREDENTIALS_ROUTE.exec(url.pathname);
      if (rotateCredentialsRoute) {
        exactForm(form, ['csrf', 'expectedRevision', 'operationId']);
        const operationId = operationIdFrom(form);
        const result = await control.rotateUserCredentials(
          sessionId,
          csrf,
          expectedRevision,
          rotateCredentialsRoute[1],
          operationId,
        );
        html(req, res, 200, renderSecretPage(result, { heading: 'All user credentials rotated' }));
        return;
      }
      if (url.pathname === '/exit-node') {
        exactForm(form, ['csrf', 'expectedRevision', 'deviceId']);
        const deviceId = valueOnce(form, 'deviceId', { max: 128 });
        await control.selectExit(sessionId, csrf, expectedRevision, deviceId);
        redirect(req, res, '/');
        return;
      }
      if (url.pathname === '/exit-nodes') {
        exactForm(form, ['csrf', 'expectedRevision', 'deviceId']);
        const deviceId = valueOnce(form, 'deviceId', { max: 128 });
        await control.addExit(sessionId, csrf, expectedRevision, deviceId);
        redirect(req, res, '/');
        return;
      }
      const removeExitRoute = EXIT_REMOVE_ROUTE.exec(url.pathname);
      if (removeExitRoute) {
        exactForm(form, ['csrf', 'expectedRevision']);
        await control.removeExit(sessionId, csrf, expectedRevision, removeExitRoute[1]);
        redirect(req, res, '/');
        return;
      }
      if (url.pathname === '/public-base') {
        exactForm(form, ['csrf', 'expectedRevision', 'url']);
        const rawUrl = valueOnce(form, 'url', { min: 9, max: 2048 });
        await control.setPublicBase(sessionId, csrf, expectedRevision, rawUrl);
        redirect(req, res, '/');
        return;
      }
      sendGenericError(req, res, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        sendGenericError(req, res, error.status);
        return;
      }
      sendControllerError(req, res, error);
    }
  };
}
