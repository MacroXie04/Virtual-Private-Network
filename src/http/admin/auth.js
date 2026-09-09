import { randomBytes } from 'node:crypto';
import { ControlError } from '../../control/socket/client-transport.js';
import { HttpError, parseCookies, readForm, requestAddress, secretEqual, serializeCookie } from '../shared/input.js';
import { sendGenericError, sendResponse } from '../shared/service.js';
import { renderErrorPage, renderLoginPage } from './pages/access.js';
import { SESSION_COOKIE, LOGIN_CSRF_COOKIE, canonicalAdminAuthority, canonicalAdminOrigin, singleHeader, exactForm, valueOnce } from './request.js';

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

export function controllerStatus(error) {
  if (!(error instanceof ControlError)) return 500;
  if ([400, 401, 403, 404, 409, 429, 503].includes(error.status)) return error.status;
  return 500;
}

export function createAdminAccess({ publicHostname, control, globalRateLimiter, loginRateLimiter }) {
  const publicOrigin = `https://${publicHostname}`;
  // Browser administration is supported only through a trusted TLS frontend.
  // The __Host- prefix additionally requires Secure, Path=/, and no Domain.
  const cookieOptions = { secure: true, httpOnly: true, sameSite: 'Strict', path: '/' };
  const clearSession = serializeCookie(SESSION_COOKIE, '', { ...cookieOptions, maxAge: 0 });
  const clearLoginCsrf = serializeCookie(LOGIN_CSRF_COOKIE, '', { ...cookieOptions, maxAge: 0 });

  // This source-wide bucket is only for traffic that has not authenticated.
  // A loopback proxy collapses client addresses, so spending it must never
  // make an already verified administrator session unavailable.
  const allowUnauthenticated = (req, res) => {
    const rate = globalRateLimiter.take(requestAddress(req));
    if (rate.allowed) return true;
    sendResponse(req, res, 429, 'Too Many Requests\n', {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': String(rate.retryAfter),
    });
    return false;
  };

  const verifyRequestSite = (req, { mutation = false } = {}) => {
    const requestHost = singleHeader(req, 'host');
    let canonicalHost;
    try {
      canonicalHost = requestHost ? canonicalAdminAuthority(requestHost) : null;
    } catch {
      canonicalHost = null;
    }
    if (!canonicalHost || canonicalHost !== publicHostname) throw new HttpError(403);
    const origin = singleHeader(req, 'origin');
    let canonicalOrigin = null;
    let canonicalOriginHost = null;
    if (origin) {
      try {
        const record = canonicalAdminOrigin(origin);
        canonicalOrigin = record.origin;
        canonicalOriginHost = record.host;
      } catch {
        throw new HttpError(403);
      }
    }
    if (mutation) {
      if (
        !canonicalOrigin
        || canonicalOrigin !== publicOrigin
        || canonicalOriginHost !== canonicalHost
      ) throw new HttpError(403);
    } else if (
      canonicalOrigin
      && (canonicalOrigin !== publicOrigin || canonicalOriginHost !== canonicalHost)
    ) {
      throw new HttpError(403);
    }
  };

  const sendControllerError = (req, res, error, { clearOnUnauthorized = true } = {}) => {
    const status = controllerStatus(error);
    if (clearOnUnauthorized && (status === 401 || status === 403)) {
      redirect(req, res, '/login', { 'set-cookie': clearSession });
      return;
    }
    html(req, res, status, renderErrorPage(status, error instanceof ControlError ? error.code : undefined));
  };

  const login = async (req, res, url) => {
    const readRequestForm = () => readForm(req, { maxBytes: 16 * 1024, timeoutMs: 5_000 });
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/login') {
      if (!allowUnauthenticated(req, res)) return;
      const csrf = randomBytes(32).toString('base64url');
      html(req, res, 200, renderLoginPage({ csrf }), {
        'set-cookie': serializeCookie(LOGIN_CSRF_COOKIE, csrf, cookieOptions),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      const loginRate = loginRateLimiter.take(requestAddress(req));
      if (!loginRate.allowed) {
        sendResponse(req, res, 429, 'Too Many Requests\n', {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': String(loginRate.retryAfter),
        });
        return;
      }
      try {
        const form = await readRequestForm();
        exactForm(form, ['csrf', 'secret']);
        const csrf = valueOnce(form, 'csrf', { min: 32, max: 128 });
        const expectedCsrf = parseCookies(req.headers.cookie)[LOGIN_CSRF_COOKIE];
        if (!secretEqual(csrf, expectedCsrf)) throw new HttpError(403);
        const secret = valueOnce(form, 'secret', { max: 4096 });
        const result = await control.login(secret);
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
        redirect(req, res, '/', {
          'set-cookie': [
            serializeCookie(SESSION_COOKIE, result.sessionId, { ...cookieOptions, maxAge }),
            clearLoginCsrf,
          ],
        });
      } catch (error) {
        if (error instanceof HttpError) {
          sendGenericError(req, res, error.status);
          return;
        }
        const status = controllerStatus(error);
        const replacementCsrf = randomBytes(32).toString('base64url');
        html(req, res, status === 401 || status === 403 ? 401 : status, renderLoginPage({ csrf: replacementCsrf, error: true }), {
          'set-cookie': serializeCookie(LOGIN_CSRF_COOKIE, replacementCsrf, cookieOptions),
        });
      }
      return;
    }
  };

  return {
    allowUnauthenticated, verifyRequestSite, sendControllerError, clearSession,
    async handleLogin(req, res, url) {
      if (url.pathname !== '/login' || !['GET', 'HEAD', 'POST'].includes(req.method)) return false;
      await login(req, res, url);
      return true;
    },
  };
}
