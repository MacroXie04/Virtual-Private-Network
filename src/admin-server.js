import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createControlClient, ControlError } from './control-client.js';
import {
  FixedWindowRateLimiter,
  HttpError,
  createHttpService,
  installGracefulShutdown,
  parseCookies,
  parseOriginForm,
  readForm,
  requestAddress,
  secretEqual,
  sendGenericError,
  sendResponse,
  serializeCookie,
} from './http-common.js';
import {
  renderDashboardPage,
  renderErrorPage,
  renderLoginPage,
  renderSecretPage,
} from './admin-page.js';

const SESSION_COOKIE = '__Host-vpn_admin_session';
const LOGIN_CSRF_COOKIE = '__Host-vpn_admin_login_csrf';
const IDENTIFIER = '[A-Za-z0-9_-]{1,128}';
const USER_STATUS_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/status$`, 'u');
const USER_REVOKE_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/revoke$`, 'u');
const USER_ROTATE_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/rotate-token$`, 'u');
const USER_ROTATE_CREDENTIALS_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/rotate-credentials$`, 'u');
const USER_EXPORT_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/export$`, 'u');

function listSetting(value, fallback) {
  const values = value === undefined
    ? fallback
    : (typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [...value]);
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('allowlist must not be empty');
  for (const item of values) {
    if (typeof item !== 'string' || item.length > 512 || /[\u0000-\u0020\u007f]/u.test(item)) {
      throw new TypeError('invalid allowlist entry');
    }
  }
  return new Set(values);
}

function canonicalAdminAuthority(value) {
  let parsed;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new TypeError('invalid administration Host allowlist entry');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || value.toLowerCase() !== parsed.host
    || isIP(hostname) !== 0
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || !hostname.includes('.')
    || hostname.endsWith('.')
  ) {
    throw new TypeError('administration requires a dedicated DNS hostname');
  }
  return parsed.host;
}

function canonicalAdminOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('invalid administration Origin allowlist entry');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || value.toLowerCase() !== parsed.origin
  ) {
    throw new TypeError('invalid administration Origin allowlist entry');
  }
  return {
    origin: parsed.origin,
    host: canonicalAdminAuthority(parsed.host),
  };
}

function singleHeader(req, name) {
  let count = 0;
  let value;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) {
      count += 1;
      value = req.rawHeaders[index + 1];
    }
  }
  return count === 1 ? value : null;
}

function valueOnce(form, name, { min = 1, max = 4096, optional = false } = {}) {
  const values = form.getAll(name);
  if (values.length !== 1) {
    if (optional && values.length === 0) return '';
    throw new HttpError(400);
  }
  const value = values[0];
  if (value.length < min || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new HttpError(400);
  return value;
}

function exactForm(form, fields) {
  const expected = new Set(fields);
  const seen = [...form.keys()];
  if (seen.length !== fields.length || seen.some((name) => !expected.has(name))) {
    throw new HttpError(400);
  }
  for (const name of fields) {
    if (form.getAll(name).length !== 1) throw new HttpError(400);
  }
}

function revisionFrom(form) {
  const value = valueOnce(form, 'expectedRevision', { max: 16 });
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new HttpError(400);
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new HttpError(400);
  return revision;
}

function operationIdFrom(form) {
  const value = valueOnce(form, 'operationId', { min: 36, max: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new HttpError(400);
  }
  return value;
}

function sessionFrom(req) {
  const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 ? value : null;
}

function sessionRateKey(sessionId) {
  return createHash('sha256').update(sessionId, 'utf8').digest('base64url');
}

function html(req, res, status, body, headers = {}) {
  sendResponse(req, res, status, body, { 'content-type': 'text/html; charset=utf-8', ...headers });
}

function redirect(req, res, location, headers = {}) {
  sendResponse(req, res, 303, '', { location, ...headers });
}

function controllerStatus(error) {
  if (!(error instanceof ControlError)) return 500;
  if ([400, 401, 403, 404, 409, 429, 503].includes(error.status)) return error.status;
  return 500;
}

/**
 * Loopback administration process API. All state and session authority remains
 * in the controller reached over its Unix socket; this server retains none.
 */
export function createAdminServer({
  host = process.env.ADMIN_HOST ?? '127.0.0.1',
  port = Number(process.env.ADMIN_PORT ?? 8081),
  allowedHosts: allowedHostsOption = process.env.ADMIN_ALLOWED_HOSTS,
  allowedOrigins: allowedOriginsOption = process.env.ADMIN_ALLOWED_ORIGINS,
  control = createControlClient(),
  globalRateLimiter = new FixedWindowRateLimiter({ limit: 6000, windowMs: 60_000, maxEntries: 1024 }),
  rateLimiter = new FixedWindowRateLimiter({ limit: 300, windowMs: 60_000, maxEntries: 1024 }),
  loginRateLimiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 5 * 60_000, maxEntries: 1024 }),
  mutationRateLimiter = new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxEntries: 1024 }),
  shutdownTimeout = 310_000,
  ...httpOptions
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid admin port');
  const dynamicDefaults = allowedHostsOption === undefined && port === 0;
  const dynamicOriginDefaults = allowedOriginsOption === undefined && port === 0;
  const defaultAuthority = `admin.vpn.invalid:${port}`;
  const hostAllowlist = new Set(
    [...listSetting(allowedHostsOption, [defaultAuthority])].map(canonicalAdminAuthority),
  );
  const originRecords = [...listSetting(allowedOriginsOption, [`https://${defaultAuthority}`])]
    .map(canonicalAdminOrigin);
  const originAllowlist = new Set(originRecords.map((entry) => entry.origin));
  const originHosts = new Set(originRecords.map((entry) => entry.host));
  if (
    hostAllowlist.size !== originHosts.size
    || [...hostAllowlist].some((entry) => !originHosts.has(entry))
  ) {
    throw new TypeError('administration Host and Origin authorities must match exactly');
  }
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
    if (!canonicalHost || !hostAllowlist.has(canonicalHost)) throw new HttpError(403);
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
        || !originAllowlist.has(canonicalOrigin)
        || canonicalOriginHost !== canonicalHost
      ) throw new HttpError(403);
    } else if (
      canonicalOrigin
      && (!originAllowlist.has(canonicalOrigin) || canonicalOriginHost !== canonicalHost)
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
    html(req, res, status, renderErrorPage(status));
  };

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
      if (url.pathname === '/public-base') {
        exactForm(form, ['csrf', 'expectedRevision', 'url']);
        const rawUrl = valueOnce(form, 'url', { min: 0, max: 2048, optional: true });
        await control.setPublicBase(sessionId, csrf, expectedRevision, rawUrl === '' ? null : rawUrl);
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

  const service = createHttpService(handler, { host, port, shutdownTimeout, ...httpOptions });
  const originalListen = service.listen.bind(service);
  service.listen = async () => {
    const address = await originalListen();
    if (address && typeof address === 'object') {
      if (dynamicDefaults) hostAllowlist.add(`admin.vpn.invalid:${address.port}`);
      if (dynamicOriginDefaults) originAllowlist.add(`https://admin.vpn.invalid:${address.port}`);
    }
    return address;
  };
  return service;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = createAdminServer();
    service.listen().then(() => installGracefulShutdown(service)).catch(() => { process.exitCode = 1; });
  } catch {
    process.exitCode = 1;
  }
}
