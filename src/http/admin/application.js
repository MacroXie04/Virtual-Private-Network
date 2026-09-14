import { createControlClient } from '../../control/socket/client.js';
import { FixedWindowRateLimiter } from '../shared/rate-limit.js';
import { HttpError, parseOriginForm } from '../shared/input.js';
import { createHttpService, sendGenericError, sendResponse, tooManyRequests } from '../shared/service.js';
import { createAdminAccess, redirect } from './auth.js';
import { createAdminRoutes } from './routes.js';
import { canonicalAdminAuthority, sessionFrom, sessionRateKey } from './request.js';
import { ADMIN_STYLES, ADMIN_STYLES_PATH } from './pages/styles.js';
import { createAdminSite } from './site.js';
import { createSubscriptionProxy } from './subscriptions.js';
import { createAccountArea } from '../account/access.js';

/**
 * Shared HTTP entry for administration and subscriptions. State and sessions
 * remain in the controller; subscriptions use the isolated loopback worker.
 */
export function createAdminServer({
  host = process.env.ADMIN_HOST ?? '127.0.0.1',
  port = Number(process.env.ADMIN_PORT ?? 8081),
  publicHostname: publicHostnameOption = process.env.ADMIN_PUBLIC_HOSTNAME,
  localHttpOrigin = process.env.LOCAL_HTTP_ORIGIN,
  subscriptionPort = Number(process.env.SUB_PORT ?? 8080),
  control = createControlClient(),
  globalRateLimiter = new FixedWindowRateLimiter({ limit: 6000, windowMs: 60_000, maxEntries: 1024 }),
  rateLimiter = new FixedWindowRateLimiter({ limit: 300, windowMs: 60_000, maxEntries: 1024 }),
  loginRateLimiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 5 * 60_000, maxEntries: 1024 }),
  mutationRateLimiter = new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxEntries: 1024 }),
  accountLoginSourceRateLimiter = new FixedWindowRateLimiter({ limit: 120, windowMs: 5 * 60_000, maxEntries: 1024 }),
  accountLoginRateLimiter = new FixedWindowRateLimiter({ limit: 10, windowMs: 10 * 60_000, maxEntries: 4096 }),
  accountRateLimiter = new FixedWindowRateLimiter({ limit: 120, windowMs: 60_000, maxEntries: 1024 }),
  accountMutationRateLimiter = new FixedWindowRateLimiter({ limit: 6, windowMs: 10 * 60_000, maxEntries: 1024 }),
  shutdownTimeout = 310_000,
  ...httpOptions
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid admin port');
  const publicHostname = canonicalAdminAuthority(publicHostnameOption ?? '');
  const site = createAdminSite(publicHostname, localHttpOrigin);
  if (host !== '127.0.0.1' && !(host === '0.0.0.0' && !site.secure)) {
    throw new TypeError('administration service must bind to IPv4 loopback unless local HTTP mode is enabled');
  }
  const access = createAdminAccess({ publicHostname, localHttpOrigin, control, globalRateLimiter, loginRateLimiter });
  const { allowUnauthenticated, verifyRequestSite, sendControllerError } = access;
  const routes = createAdminRoutes({ control, mutationRateLimiter, access });
  const subscriptions = createSubscriptionProxy({ publicHostname, port: subscriptionPort });
  const account = createAccountArea({
    control, site, publicOrigin: access.publicOrigin, allowUnauthenticated,
    accountLoginSourceRateLimiter, accountLoginRateLimiter, accountRateLimiter, accountMutationRateLimiter,
  });
  const handler = async (req, res) => {
    let url;
    // Classify only for error isolation; parsing and Host checks still gate routing.
    const subscriptionRequest = /^\/s(?:\/|\?|$)/u.test(req.url ?? '');
    try {
      url = parseOriginForm(req.url);
      if (url.pathname === '/s' || url.pathname.startsWith('/s/')) {
        access.verifyRequestHost(req);
        await subscriptions(req, res, url);
        return;
      }
      if (url.search !== '') throw new HttpError(400);
      verifyRequestSite(req, { mutation: req.method === 'POST' });
    } catch (error) {
      if (!subscriptionRequest && !allowUnauthenticated(req, res)) return;
      const status = error instanceof HttpError ? error.status : 400;
      sendGenericError(req, res, subscriptionRequest && status === 400 ? 404 : status);
      return;
    }

    // End users have their own realm: cookies, limits and sign-in page never touch the administrator's.
    if (url.pathname === '/account' || url.pathname.startsWith('/account/')) {
      await account.handle(req, res, url);
      return;
    }
    if (await access.handleLogin(req, res, url)) return;

    // Same-origin stylesheet required by every page, including both sign-in pages.
    if (url.pathname === ADMIN_STYLES_PATH && ['GET', 'HEAD'].includes(req.method)) {
      if (
        !sessionFrom(req, access.sessionCookie)
        && !sessionFrom(req, account.sessionCookie)
        && !allowUnauthenticated(req, res)
      ) return;
      sendResponse(req, res, 200, ADMIN_STYLES, { 'content-type': 'text/css; charset=utf-8' });
      return;
    }

    const sessionId = sessionFrom(req, access.sessionCookie);
    if (!sessionId) {
      // Nothing presented, nothing cleared: a cross-site link must not sign the administrator out.
      if (!allowUnauthenticated(req, res)) return;
      redirect(req, res, '/login');
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
      tooManyRequests(req, res, rate);
      return;
    }

    await routes(req, res, url, sessionId);
  };
  return createHttpService(handler, { host, port, shutdownTimeout, ...httpOptions });
}
