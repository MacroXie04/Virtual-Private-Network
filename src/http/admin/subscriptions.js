import http from 'node:http';
import { validatePublicDnsHostname } from '../../core/validation/ingress.js';
import { MAX_HEADER_BYTES, parseOriginForm } from '../shared/input.js';
import { SECURITY_HEADERS, sendGenericError, sendResponse } from '../shared/service.js';
import { TOKEN_ROUTE } from '../subscription/request.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 10_000;
const PUBLIC_ERRORS = new Map([[404, 'Not Found\n'], [429, 'Too Many Requests\n'], [503, 'Service Unavailable\n']]);

function responseHeaders(response) {
  const headers = {};
  for (const name of ['content-type', 'content-disposition', 'retry-after']) {
    if (typeof response.headers[name] === 'string') headers[name] = response.headers[name];
  }
  return headers;
}

function contentLength(response) {
  const raw = response.headers['content-length'];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^\d+$/u.test(raw)) throw new Error('invalid response size');
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size > MAX_RESPONSE_BYTES) throw new Error('invalid response size');
  return size;
}

function sendUpstreamResponse(req, res, response, body, length) {
  const status = response.statusCode;
  const headers = responseHeaders(response);
  if (PUBLIC_ERRORS.has(status)) {
    sendResponse(req, res, status, PUBLIC_ERRORS.get(status), {
      'content-type': 'text/plain; charset=utf-8',
      ...(headers['retry-after'] ? { 'retry-after': headers['retry-after'] } : {}),
    });
  } else if (req.method === 'HEAD') {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, { ...headers, ...SECURITY_HEADERS, 'content-length': String(length) });
    res.end();
  } else {
    sendResponse(req, res, 200, body, headers);
  }
}

/** Fixed local subscription transport; administrator credentials never cross it. */
export function createSubscriptionProxy({
  publicHostname,
  port = Number(process.env.SUB_PORT ?? 8080),
  request = http.request,
} = {}) {
  const hostname = validatePublicDnsHostname(publicHostname, 'ADMIN_PUBLIC_HOSTNAME');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('invalid subscription port');
  return async (req, res, url) => {
    if (url.pathname !== '/s' && !url.pathname.startsWith('/s/')) return false;
    let target;
    try {
      target = parseOriginForm(req.url);
      if (!['GET', 'HEAD'].includes(req.method) || target.search !== '' || !TOKEN_ROUTE.test(target.pathname)) {
        throw new Error('invalid subscription route');
      }
    } catch {
      sendGenericError(req, res, 404);
      return true;
    }
    await new Promise((resolve) => {
      let upstream;
      let response;
      let settled = false;
      const finish = (failed = false, disconnected = false, body, length) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.off('aborted', onDisconnect);
        res.off('close', onDisconnect);
        if (failed || disconnected) {
          response?.destroy();
          upstream?.destroy();
        }
        if (!disconnected) {
          if (failed) sendGenericError(req, res, 503);
          else sendUpstreamResponse(req, res, response, body, length);
        }
        resolve();
      };
      const onDisconnect = () => finish(false, true);
      const timer = setTimeout(() => finish(true), RESPONSE_TIMEOUT_MS);
      timer.unref?.();
      req.once('aborted', onDisconnect);
      res.once('close', onDisconnect);
      if (req.aborted || res.destroyed) { finish(false, true); return; }
      try {
        upstream = request({
          host: '127.0.0.1', port, method: req.method, path: target.pathname,
          headers: { host: hostname }, agent: false, maxHeaderSize: MAX_HEADER_BYTES,
        }, (incoming) => {
          response = incoming;
          if (settled) { response.destroy(); return; }
          response.on('error', () => finish(true));
          response.once('aborted', () => finish(true));
          response.once('close', () => { if (!response.complete) finish(true); });
          let length;
          try {
            length = contentLength(response);
            if (response.statusCode !== 200 && !PUBLIC_ERRORS.has(response.statusCode)) throw new Error('invalid status');
            if (response.headers['content-encoding']) throw new Error('unexpected encoding');
            if (req.method === 'HEAD' && length === null) throw new Error('missing response size');
          } catch { finish(true); return; }
          let size = 0;
          const chunks = [];
          response.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) { finish(true); return; }
            chunks.push(chunk);
          });
          response.once('end', () => {
            if (!response.complete) { finish(true); return; }
            if (req.method !== 'HEAD' && length !== null && length !== size) { finish(true); return; }
            finish(false, false, Buffer.concat(chunks), length);
          });
        });
        upstream.on('error', () => finish(true));
        upstream.end();
      } catch { finish(true); }
    });
    return true;
  };
}
