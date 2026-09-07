import http from 'node:http';
import { HttpError, MAX_HEADER_BYTES } from './request-input.js';

export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

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
