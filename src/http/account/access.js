import { createHash, randomBytes } from 'node:crypto';
import { ControlError } from '../../control/socket/client-transport.js';
import { normalizeDisplayName } from '../../core/validation/values.js';
import { HttpError, parseCookies, readForm, requestAddress, secretEqual, serializeCookie } from '../shared/input.js';
import { sendGenericError, tooManyRequests } from '../shared/service.js';
import { controllerStatus, html, issuedSessionCookie, redirect } from '../admin/auth.js';
import { exactForm, sessionFrom, sessionRateKey, valueOnce } from '../admin/request.js';
import { renderErrorPage } from '../admin/pages/access.js';
import { renderAccountLoginPage } from './pages.js';
import { createAccountRoutes } from './routes.js';

export const ACCOUNT_SESSION_COOKIE = '__Host-vpn_account_session';
export const ACCOUNT_LOGIN_CSRF_COOKIE = '__Host-vpn_account_login_csrf';
const LOGIN_PATH = '/account/login';

/** Spelling and case variants of one display name share a single sign-in budget. */
function signInNameKey(displayName) {
  return createHash('sha256').update(displayName.normalize('NFC').toLowerCase(), 'utf8').digest('base64url');
}

/**
 * The end-user realm on the administration origin: its own cookies, limits,
 * sign-in page and error handling. It never reads or clears administrator cookies.
 */
export function createAccountArea({
  control, site, publicOrigin, allowUnauthenticated,
  accountLoginSourceRateLimiter, accountLoginRateLimiter, accountRateLimiter, accountMutationRateLimiter,
}) {
  const sessionCookie = site.secure ? ACCOUNT_SESSION_COOKIE : 'vpn_account_session_local';
  const loginCsrfCookie = site.secure ? ACCOUNT_LOGIN_CSRF_COOKIE : 'vpn_account_login_csrf_local';
  const cookieOptions = { secure: site.secure, httpOnly: true, sameSite: 'Strict', path: '/' };
  const clearSession = serializeCookie(sessionCookie, '', { ...cookieOptions, maxAge: 0 });
  const clearLoginCsrf = serializeCookie(loginCsrfCookie, '', { ...cookieOptions, maxAge: 0 });

  const sendAccountError = (req, res, error) => {
    const status = controllerStatus(error);
    if (status === 401 || status === 403) {
      redirect(req, res, LOGIN_PATH, { 'set-cookie': clearSession });
      return;
    }
    const code = error instanceof ControlError ? error.code : undefined;
    html(req, res, status, renderErrorPage(status, code, { home: '/account' }));
  };

  const showLogin = (req, res, status, options = {}) => {
    const csrf = randomBytes(32).toString('base64url');
    html(req, res, status, renderAccountLoginPage({ csrf, ...options }), {
      'set-cookie': serializeCookie(loginCsrfCookie, csrf, cookieOptions),
    });
  };

  const login = async (req, res) => {
    // Behind the tunnel every client shares one address, so this is the portal-wide sign-in budget.
    const sourceRate = accountLoginSourceRateLimiter.take(requestAddress(req));
    if (!sourceRate.allowed) {
      tooManyRequests(req, res, sourceRate);
      return;
    }
    let displayName = '';
    try {
      const form = await readForm(req, { maxBytes: 16 * 1024, timeoutMs: 5_000 });
      exactForm(form, ['csrf', 'displayName', 'password']);
      const csrf = valueOnce(form, 'csrf', { min: 32, max: 128 });
      if (!secretEqual(csrf, parseCookies(req.headers.cookie)[loginCsrfCookie])) throw new HttpError(403);
      displayName = valueOnce(form, 'displayName', { min: 0, max: 128 }).trim();
      const password = valueOnce(form, 'password', { min: 0, max: 1024 });
      if (displayName === '' || password === '') {
        showLogin(req, res, 400, { displayName, missingName: displayName === '', missingPassword: password === '' });
        return;
      }
      let normalized;
      try {
        normalized = normalizeDisplayName(displayName, 'displayName');
      } catch {
        // Stored names are always valid, so this one can never match: fail like any other sign-in.
        showLogin(req, res, 401, { displayName, error: true });
        return;
      }
      const nameRate = accountLoginRateLimiter.take(signInNameKey(normalized));
      if (!nameRate.allowed) {
        tooManyRequests(req, res, nameRate);
        return;
      }
      const result = await control.accountLogin(normalized, password);
      redirect(req, res, '/account', {
        'set-cookie': [issuedSessionCookie(result, sessionCookie, cookieOptions), clearLoginCsrf],
      });
    } catch (error) {
      if (error instanceof HttpError) {
        sendGenericError(req, res, error.status);
        return;
      }
      const status = controllerStatus(error);
      showLogin(req, res, status === 401 || status === 403 ? 401 : status, { displayName, error: true });
    }
  };

  const routes = createAccountRoutes({ control, publicOrigin, sendAccountError, clearSession, accountMutationRateLimiter });

  return {
    sessionCookie,
    async handle(req, res, url) {
      if (url.pathname === LOGIN_PATH) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (!allowUnauthenticated(req, res)) return;
          showLogin(req, res, 200);
        } else if (req.method === 'POST') {
          await login(req, res);
        } else {
          sendGenericError(req, res, 404);
        }
        return;
      }
      const sessionId = sessionFrom(req, sessionCookie);
      if (!sessionId) {
        // Nothing was presented, so nothing is cleared: a cross-site link (which
        // omits SameSite=Strict cookies) must not be able to sign a user out.
        if (!allowUnauthenticated(req, res)) return;
        redirect(req, res, LOGIN_PATH);
        return;
      }
      // The per-session budget is keyed by the presented cookie's digest, so it can be
      // spent before the controller round trip and shield the socket from a flood.
      const rate = accountRateLimiter.take(sessionRateKey(sessionId));
      if (!rate.allowed) {
        tooManyRequests(req, res, rate);
        return;
      }
      try {
        await control.accountCheck(sessionId);
      } catch (error) {
        if (!allowUnauthenticated(req, res)) return;
        sendAccountError(req, res, error);
        return;
      }
      await routes(req, res, url, sessionId);
    },
  };
}
