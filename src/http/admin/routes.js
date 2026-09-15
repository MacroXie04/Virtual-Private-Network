import { ControlError } from '../../control/socket/client-transport.js';
import { HttpError, readForm } from '../shared/input.js';
import { sendGenericError, sendResponse, tooManyRequests } from '../shared/service.js';
import { renderExitNodesPage, renderOverviewPage, renderUsersPage } from './pages/dashboard.js';
import { html, redirect } from './auth.js';
import { exactForm, valueOnce, revisionFrom, sessionRateKey } from './request.js';
import { createUserRoutes } from './user-routes.js';

const IDENTIFIER = '[A-Za-z0-9_-]{1,128}';
const USER_EXPORT_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/export$`, 'u');
const EXIT_REMOVE_ROUTE = /^\/exit-nodes\/([0-9a-f]{16})\/remove$/u;
const PAGES = new Map([
  ['/', renderOverviewPage],
  ['/exit-nodes', renderExitNodesPage],
  ['/users', renderUsersPage],
]);

export function createAdminRoutes({ control, mutationRateLimiter, access }) {
  const { sendControllerError, clearSession, publicOrigin } = access;
  // Pages render from a fresh snapshot. Form input errors re-render the same
  // page with the offending field flagged instead of a generic error page.
  const sendPage = async (req, res, sessionId, renderPage, status = 200, options = {}) => {
    try {
      const snapshot = await control.snapshot(sessionId);
      if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.csrf !== 'string') {
        throw new ControlError('INTERNAL', 500);
      }
      html(req, res, status, renderPage(snapshot, { publicOrigin, ...options }));
    } catch (error) {
      sendControllerError(req, res, error);
    }
  };
  const userRoutes = createUserRoutes({ control, sendPage });

  return async (req, res, url, sessionId) => {
    const authenticatedRateKey = sessionRateKey(sessionId);
    const readRequestForm = () => readForm(req, { maxBytes: 16 * 1024, timeoutMs: 5_000 });
    const renderPage = PAGES.get(url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && renderPage) {
      await sendPage(req, res, sessionId, renderPage);
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
      tooManyRequests(req, res, mutationRate);
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
      if (await userRoutes(req, res, url, { form, csrf, sessionId, expectedRevision })) return;
      if (url.pathname === '/exit-node') {
        exactForm(form, ['csrf', 'expectedRevision', 'deviceId']);
        const deviceId = valueOnce(form, 'deviceId', { max: 128 });
        await control.selectExit(sessionId, csrf, expectedRevision, deviceId);
        redirect(req, res, '/exit-nodes');
        return;
      }
      if (url.pathname === '/exit-nodes') {
        exactForm(form, ['csrf', 'expectedRevision', 'deviceId']);
        const deviceId = valueOnce(form, 'deviceId', { max: 128 });
        await control.addExit(sessionId, csrf, expectedRevision, deviceId);
        redirect(req, res, '/exit-nodes');
        return;
      }
      const removeExitRoute = EXIT_REMOVE_ROUTE.exec(url.pathname);
      if (removeExitRoute) {
        exactForm(form, ['csrf', 'expectedRevision']);
        await control.removeExit(sessionId, csrf, expectedRevision, removeExitRoute[1]);
        redirect(req, res, '/exit-nodes');
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
