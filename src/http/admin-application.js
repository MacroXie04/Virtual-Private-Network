import { createControlClient } from '../control/control-client.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { HttpError, parseOriginForm } from './request-input.js';
import { createHttpService, sendGenericError, sendResponse } from './http-service.js';
import { createAdminAccess, redirect } from './admin-auth.js';
import { createAdminRoutes } from './admin-routes.js';
import { canonicalAdminAuthority, sessionFrom, sessionRateKey } from './admin-request.js';

/**
 * Loopback administration process API. All state and session authority remains
 * in the controller reached over its Unix socket; this server retains none.
 */
export function createAdminServer({
  host = process.env.ADMIN_HOST ?? '127.0.0.1',
  port = Number(process.env.ADMIN_PORT ?? 8081),
  publicHostname: publicHostnameOption = process.env.ADMIN_PUBLIC_HOSTNAME,
  control = createControlClient(),
  globalRateLimiter = new FixedWindowRateLimiter({ limit: 6000, windowMs: 60_000, maxEntries: 1024 }),
  rateLimiter = new FixedWindowRateLimiter({ limit: 300, windowMs: 60_000, maxEntries: 1024 }),
  loginRateLimiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 5 * 60_000, maxEntries: 1024 }),
  mutationRateLimiter = new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxEntries: 1024 }),
  shutdownTimeout = 310_000,
  ...httpOptions
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid admin port');
  if (host !== '127.0.0.1') throw new TypeError('administration service must bind to IPv4 loopback');
  const publicHostname = canonicalAdminAuthority(publicHostnameOption ?? '');
  const access = createAdminAccess({ publicHostname, control, globalRateLimiter, loginRateLimiter });
  const { allowUnauthenticated, verifyRequestSite, sendControllerError, clearSession } = access;
  const routes = createAdminRoutes({ control, mutationRateLimiter, access });
  const handler = async (req, res) => {
    let url;
    try {
      url = parseOriginForm(req.url);
      if (url.search !== '') throw new HttpError(400);
      verifyRequestSite(req, { mutation: req.method === 'POST' });
    } catch (error) {
      if (!allowUnauthenticated(req, res)) return;
      sendGenericError(req, res, error instanceof HttpError ? error.status : 400);
      return;
    }

    if (await access.handleLogin(req, res, url)) return;

    const sessionId = sessionFrom(req);
    if (!sessionId) {
      if (!allowUnauthenticated(req, res)) return;
      redirect(req, res, '/login', { 'set-cookie': clearSession });
      return;
    }
    try {
      await control.checkSession(sessionId);
    } catch (error) {
      if (!allowUnauthenticated(req, res)) return;
      sendControllerError(req, res, error);
      return;
    }
    const authenticatedRateKey = sessionRateKey(sessionId);
    const rate = rateLimiter.take(authenticatedRateKey);
    if (!rate.allowed) {
      sendResponse(req, res, 429, 'Too Many Requests\n', {
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': String(rate.retryAfter),
      });
      return;
    }

    await routes(req, res, url, sessionId);
  };
  return createHttpService(handler, { host, port, shutdownTimeout, ...httpOptions });
}
