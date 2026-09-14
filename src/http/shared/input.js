import { timingSafeEqual } from 'node:crypto';

export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_BODY_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(status, message = 'Request rejected') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Parse only an HTTP origin-form request target, never a proxy absolute-form URL. */
export function parseOriginForm(target) {
  const rawPath = typeof target === 'string' ? target.split('?', 1)[0] : '';
  if (
    typeof target !== 'string'
    || target.length === 0
    || target.length > 4096
    || !target.startsWith('/')
    || target.startsWith('//')
    || target.includes('\\')
    || target.includes('#')
    || /[\u0000-\u001f\u007f-\u009f]/u.test(target)
    || /%(?:0[0-9a-f]|1[0-9a-f]|2e|2f|5c|7f)/iu.test(target)
    || rawPath.includes('//')
    || rawPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new HttpError(400);
  }

  let parsed;
  try {
    parsed = new URL(target, 'http://request.invalid');
  } catch {
    throw new HttpError(400);
  }
  if (parsed.origin !== 'http://request.invalid') throw new HttpError(400);
  return parsed;
}

export function requestAddress(req) {
  return req.socket?.remoteAddress || 'unknown';
}

export function readBody(req, { maxBytes = MAX_BODY_BYTES, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers['content-length'];
    if (contentLength !== undefined) {
      if (!/^\d+$/u.test(contentLength)) {
        reject(new HttpError(400));
        return;
      }
      if (Number(contentLength) > maxBytes) {
        req.resume();
        reject(new HttpError(413));
        return;
      }
    }

    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.resume();
        finish(new HttpError(413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onAborted = () => finish(new HttpError(400));
    const onError = () => finish(new HttpError(400));
    const timer = setTimeout(() => {
      req.resume();
      finish(new HttpError(408));
    }, timeoutMs);
    timer.unref?.();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
  });
}

export async function readForm(req, options) {
  const type = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw new HttpError(415);
  const body = await readBody(req, options);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new HttpError(400);
  }
  if (/%(?![0-9a-f]{2})/iu.test(text)) throw new HttpError(400);
  return new URLSearchParams(text);
}

export function parseCookies(header, { maxCookies = 32 } = {}) {
  const cookies = Object.create(null);
  if (typeof header !== 'string' || header.length > MAX_HEADER_BYTES) return cookies;
  const pieces = header.split(';');
  if (pieces.length > maxCookies) return cookies;
  for (const piece of pieces) {
    const index = piece.indexOf('=');
    if (index < 1) continue;
    const name = piece.slice(0, index).trim();
    const value = piece.slice(index + 1).trim();
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)
      || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u.test(value)
    ) continue;
    if (!Object.hasOwn(cookies, name)) cookies[name] = value;
  }
  return cookies;
}

export function serializeCookie(name, value, {
  httpOnly = true,
  sameSite = 'Strict',
  secure = false,
  path = '/',
  maxAge,
} = {}) {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) throw new TypeError('invalid cookie name');
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u.test(value)) {
    throw new TypeError('invalid cookie value');
  }
  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (Number.isInteger(maxAge)) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

export function secretEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
