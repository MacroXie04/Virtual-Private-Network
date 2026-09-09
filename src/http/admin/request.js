import { createHash } from 'node:crypto';
import { HttpError, parseCookies } from '../shared/input.js';
import { validatePublicDnsHostname } from '../../core/validation/ingress.js';

export const SESSION_COOKIE = '__Host-vpn_admin_session';
export const LOGIN_CSRF_COOKIE = '__Host-vpn_admin_login_csrf';

export function canonicalAdminAuthority(value) {
  try {
    return validatePublicDnsHostname(value, 'ADMIN_PUBLIC_HOSTNAME');
  } catch {
    throw new TypeError('administration requires a dedicated DNS hostname');
  }
}

export function canonicalAdminOrigin(value) {
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
  const host = canonicalAdminAuthority(parsed.hostname);
  if (parsed.port || parsed.origin !== `https://${host}`) {
    throw new TypeError('invalid administration Origin');
  }
  return { origin: parsed.origin, host };
}

export function singleHeader(req, name) {
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

export function valueOnce(form, name, { min = 1, max = 4096, optional = false } = {}) {
  const values = form.getAll(name);
  if (values.length !== 1) {
    if (optional && values.length === 0) return '';
    throw new HttpError(400);
  }
  const value = values[0];
  if (value.length < min || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new HttpError(400);
  return value;
}

export function exactForm(form, fields) {
  const expected = new Set(fields);
  const seen = [...form.keys()];
  if (seen.length !== fields.length || seen.some((name) => !expected.has(name))) {
    throw new HttpError(400);
  }
  for (const name of fields) {
    if (form.getAll(name).length !== 1) throw new HttpError(400);
  }
}

export function revisionFrom(form) {
  const value = valueOnce(form, 'expectedRevision', { max: 16 });
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new HttpError(400);
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new HttpError(400);
  return revision;
}

export function operationIdFrom(form) {
  const value = valueOnce(form, 'operationId', { min: 36, max: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new HttpError(400);
  }
  return value;
}

export function sessionFrom(req) {
  const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 ? value : null;
}

export function sessionRateKey(sessionId) {
  return createHash('sha256').update(sessionId, 'utf8').digest('base64url');
}
