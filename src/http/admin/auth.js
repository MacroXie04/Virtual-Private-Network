import { randomBytes } from 'node:crypto';
import { ControlError } from '../../control/socket/client-transport.js';
import { HttpError, parseCookies, readForm, requestAddress, secretEqual, serializeCookie } from '../shared/input.js';
import { sendGenericError, sendResponse, tooManyRequests } from '../shared/service.js';
import { renderErrorPage, renderLoginPage } from './pages/access.js';
import { createAdminSite, verifyAdminRequestHost, verifyAdminRequestSite } from './site.js';
import { SESSION_COOKIE, LOGIN_CSRF_COOKIE, exactForm, valueOnce } from './request.js';

export function html(req, res, status, body, headers = {}) {
  sendResponse(req, res, status, body, {
    'content-type': 'text/html; charset=utf-8',
    ...headers,
    'referrer-policy': 'same-origin',
  });
}

export function redirect(req, res, location, headers = {}) {
  sendResponse(req, res, 303, '', { location, ...headers });
}

/** Validate a controller-issued session and serialize its cookie; the id itself is never inspected further. */
export function issuedSessionCookie(result, cookieName, cookieOptions) {
  if (
    !result
    || typeof result.sessionId !== 'string'
    || result.sessionId.length < 16
    || result.sessionId.length > 512
    || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/u.test(result.sessionId)
    || typeof result.csrf !== 'string'
    || result.csrf.length < 1
    || result.csrf.length > 512
  ) throw new ControlError('INTERNAL', 500);
  const expiresAt = Date.parse(result.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new ControlError('INTERNAL', 500);
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  return serializeCookie(cookieName, result.sessionId, { ...cookieOptions, maxAge });
}

export function controllerStatus(error) {
  if (!(error instanceof ControlError)) return 500;
  if ([400, 401, 403, 404, 409, 429, 503].includes(error.status)) return error.status;
  return 500;
}

export function createAdminAccess({ publicHostname, localHttpOrigin, control, globalRateLimiter, loginRateLimiter }) {
  const site = createAdminSite(publicHostname, localHttpOrigin);
  const sessionCookie = site.secure ? SESSION_COOKIE : 'vpn_admin_session_local';
  const loginCsrfCookie = site.secure ? LOGIN_CSRF_COOKIE : 'vpn_admin_login_csrf_local';
  const cookieOptions = { secure: site.secure, httpOnly: true, sameSite: 'Strict', path: '/' };
  const clearSession = serializeCookie(sessionCookie, '', { ...cookieOptions, maxAge: 0 });
  const clearLoginCsrf = serializeCookie(loginCsrfCookie, '', { ...cookieOptions, maxAge: 0 });

  // This source-wide bucket is only for traffic that has not authenticated.
  // A loopback proxy collapses client addresses, so spending it must never
  // make an already verified administrator session unavailable.
  const allowUnauthenticated = (req, res) => {
    const rate = globalRateLimiter.take(requestAddress(req));
    if (rate.allowed) return true;
    tooManyRequests(req, res, rate);
    return false;
  };

  const sendControllerError = (req, res, error) => {
    const status = controllerStatus(error);
    if (status === 401 || status === 403) {
      redirect(req, res, '/login', { 'set-cookie': clearSession });
      return;
    }
    html(req, res, status, renderErrorPage(status, error instanceof ControlError ? error.code : undefined));
  };

  const failLogin = (req, res, status, options) => {
    const replacementCsrf = randomBytes(32).toString('base64url');
    html(req, res, status, renderLoginPage({ csrf: replacementCsrf, ...options }), {
      'set-cookie': serializeCookie(loginCsrfCookie, replacementCsrf, cookieOptions),
    });
  };

  const login = async (req, res, url) => {
    const readRequestForm = () => readForm(req, { maxBytes: 16 * 1024, timeoutMs: 5_000 });
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/login') {
      if (!allowUnauthenticated(req, res)) return;
      const csrf = randomBytes(32).toString('base64url');
      html(req, res, 200, renderLoginPage({ csrf }), {
        'set-cookie': serializeCookie(loginCsrfCookie, csrf, cookieOptions),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      const loginRate = loginRateLimiter.take(requestAddress(req));
      if (!loginRate.allowed) {
        tooManyRequests(req, res, loginRate);
        return;
      }
      try {
        const form = await readRequestForm();
        exactForm(form, ['csrf', 'secret']);
        const csrf = valueOnce(form, 'csrf', { min: 32, max: 128 });
        const expectedCsrf = parseCookies(req.headers.cookie)[loginCsrfCookie];
        if (!secretEqual(csrf, expectedCsrf)) throw new HttpError(403);
        const secret = valueOnce(form, 'secret', { min: 0, max: 4096 });
        if (secret === '') {
          failLogin(req, res, 400, { missingSecret: true });
          return;
        }
        const result = await control.login(secret);
        redirect(req, res, '/overview', {
          'set-cookie': [issuedSessionCookie(result, sessionCookie, cookieOptions), clearLoginCsrf],
        });
      } catch (error) {
        if (error instanceof HttpError) {
          sendGenericError(req, res, error.status);
          return;
        }
        const status = controllerStatus(error);
        failLogin(req, res, status === 401 || status === 403 ? 401 : status, { error: true });
      }
      return;
    }
  };

  return {
    allowUnauthenticated, sendControllerError, clearSession, sessionCookie, publicOrigin: site.origin,
    verifyRequestHost: (req) => verifyAdminRequestHost(req, site),
    verifyRequestSite: (req, options) => verifyAdminRequestSite(req, site, options),
    async handleLogin(req, res, url) {
      if (url.pathname !== '/login' || !['GET', 'HEAD', 'POST'].includes(req.method)) return false;
      await login(req, res, url);
      return true;
    },
  };
}
