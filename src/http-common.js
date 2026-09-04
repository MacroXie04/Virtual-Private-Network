import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_BODY_BYTES = 16 * 1024;

export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

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

/**
 * Memory-bounded fixed-window limiter. Once the key table is full, unseen
 * addresses share one deliberately conservative overflow bucket.
 */
export class FixedWindowRateLimiter {
  constructor({ limit = 60, windowMs = 60_000, maxEntries = 1024, now = Date.now } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be positive');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs must be positive');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be positive');
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.overflow = { count: 0, resetAt: 0 };
  }

  take(key) {
    const now = this.now();
    const normalized = typeof key === 'string' && key ? key : 'unknown';
    let entry = this.entries.get(normalized);

    if (!entry && this.entries.size >= this.maxEntries) {
      for (const [storedKey, stored] of this.entries) {
        if (now >= stored.resetAt) this.entries.delete(storedKey);
      }
    }
    if (!entry && this.entries.size < this.maxEntries) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(normalized, entry);
    } else if (!entry) {
      entry = this.overflow;
    }

    if (now >= entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + this.windowMs;
    }
    entry.count += 1;
    return {
      allowed: entry.count <= this.limit,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
}

export function sendResponse(req, res, status, body = '', headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const merged = {
    ...headers,
    ...SECURITY_HEADERS,
    'content-length': String(payload.length),
  };
  res.writeHead(status, merged);
  if (req.method === 'HEAD' || status === 204 || status === 304) res.end();
  else res.end(payload);
}

export function sendGenericError(req, res, status = 500) {
  const publicStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const labels = new Map([
    [400, 'Bad Request\n'],
    [401, 'Unauthorized\n'],
    [403, 'Forbidden\n'],
    [404, 'Not Found\n'],
    [405, 'Method Not Allowed\n'],
    [408, 'Request Timeout\n'],
    [413, 'Payload Too Large\n'],
    [415, 'Unsupported Media Type\n'],
    [429, 'Too Many Requests\n'],
    [503, 'Service Unavailable\n'],
  ]);
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
  };
  if (publicStatus === 408 || publicStatus === 413) headers.connection = 'close';
  sendResponse(req, res, publicStatus, labels.get(publicStatus) ?? 'Internal Server Error\n', headers);
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

/** Create a hardened HTTP/1 server with a promise-based lifecycle. */
export function createHttpService(handler, {
  host = '127.0.0.1',
  port = 0,
  maxHeaderSize = MAX_HEADER_BYTES,
  headersTimeout = 10_000,
  requestTimeout = 15_000,
  keepAliveTimeout = 5_000,
  shutdownTimeout = 5_000,
} = {}) {
  const server = http.createServer({
    maxHeaderSize,
    requireHostHeader: true,
    connectionsCheckingInterval: 1_000,
  }, (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      sendGenericError(req, res, error instanceof HttpError ? error.status : 500);
    });
  });
  server.headersTimeout = headersTimeout;
  server.requestTimeout = requestTimeout;
  server.keepAliveTimeout = keepAliveTimeout;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  server.on('checkContinue', (req, res) => sendGenericError(req, res, 413));

  return {
    server,
    async listen() {
      if (server.listening) return server.address();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      const deadline = setTimeout(() => server.closeAllConnections?.(), shutdownTimeout);
      deadline.unref?.();
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(resolve));
      clearTimeout(deadline);
    },
  };
}

/** Register SIGINT/SIGTERM handlers and return a function that removes them. */
export function installGracefulShutdown(service) {
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    service.close().finally(() => { process.exitCode = 0; });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
}
