import { HttpError } from '../shared/input.js';
import { canonicalAdminAuthority, canonicalAdminOrigin, singleHeader } from './request.js';

/** HTTP is opt-in and limited to an exact loopback browser origin. */
export function validateLocalHttpOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('LOCAL_HTTP_ORIGIN must be a canonical HTTP loopback origin');
  }
  if (
    parsed.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash
    || value !== parsed.origin
  ) throw new TypeError('LOCAL_HTTP_ORIGIN must be a canonical HTTP loopback origin');
  return parsed.origin;
}

export function createAdminSite(publicHostname, localHttpOrigin) {
  const secure = localHttpOrigin === undefined || localHttpOrigin === '';
  const origin = secure ? `https://${publicHostname}` : validateLocalHttpOrigin(localHttpOrigin);
  return { origin, secure, authority: new URL(origin).host };
}

export function verifyAdminRequestHost(req, site) {
  const value = singleHeader(req, 'host');
  let authority;
  try {
    authority = site.secure ? canonicalAdminAuthority(value) : value?.toLowerCase();
  } catch {
    throw new HttpError(403);
  }
  if (authority !== site.authority) throw new HttpError(403);
}

export function verifyAdminRequestSite(req, site, { mutation = false } = {}) {
  verifyAdminRequestHost(req, site);
  const origin = singleHeader(req, 'origin');
  const hasOrigin = req.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'origin');
  if (!origin) {
    if (mutation || hasOrigin) throw new HttpError(403);
    return;
  }
  let canonicalOrigin;
  try {
    canonicalOrigin = site.secure ? canonicalAdminOrigin(origin).origin : validateLocalHttpOrigin(origin);
  } catch {
    throw new HttpError(403);
  }
  if (canonicalOrigin !== site.origin) throw new HttpError(403);
}
