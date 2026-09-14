import { EventEmitter } from 'node:events';
import { createSubscriptionProxy } from '../../src/http/admin/subscriptions.js';
import { parseOriginForm } from '../../src/http/shared/input.js';

export function proxyFixture({ method = 'GET', status = 200, headers = {}, start = () => {} } = {}) {
  const req = Object.assign(new EventEmitter(), { method, url: `/s/${'Z'.repeat(43)}/links`, aborted: false });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, headersSent: false, body: Buffer.alloc(0),
    writeHead(statusCode, values) { this.statusCode = statusCode; this.headers = values; this.headersSent = true; },
    end(body) { this.body = body ?? Buffer.alloc(0); this.emit('close'); },
  });
  const incoming = Object.assign(new EventEmitter(), {
    statusCode: status, headers, complete: false, destroyed: false,
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  const upstream = Object.assign(new EventEmitter(), {
    destroyed: false, destroy() { this.destroyed = true; },
    end() { start(incoming, upstream); },
  });
  let connect;
  const proxy = createSubscriptionProxy({
    publicHostname: 'admin.example.com', port: 8080,
    request(options, callback) { connect = () => callback(incoming); upstream.options = options; return upstream; },
  });
  const pending = proxy(req, res, parseOriginForm(req.url));
  return { req, res, incoming, upstream, pending, connect: () => connect() };
}

export function endResponse(incoming, body = '') {
  if (body.length > 0) incoming.emit('data', Buffer.from(body));
  incoming.complete = true;
  incoming.emit('end');
  incoming.emit('close');
}
