import net from 'node:net';
import { randomUUID } from 'node:crypto';

const ALLOWED_OPERATIONS = new Set([
  'auth.login',
  'auth.logout',
  'auth.check',
  'admin.snapshot',
  'user.create',
  'user.setStatus',
  'user.revoke',
  'user.rotateToken',
  'user.rotateCredentials',
  'user.export',
  'exit.select',
  'exit.add',
  'exit.remove',
  'publicBase.set',
  'health.status',
]);

export class ControlError extends Error {
  constructor(code = 'UNAVAILABLE', status = 503) {
    super('Controller request failed');
    this.name = 'ControlError';
    this.code = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) ? code : 'INTERNAL';
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function transportFailure() {
  const error = new ControlError();
  Object.defineProperty(error, 'transportFailure', { value: true });
  return error;
}

/**
 * Create an NDJSON Unix-socket client. `request(op, fields)` sends exactly one
 * `{id,op,...fields}` envelope and resolves to the response `result`.
 */
export function createControlClient({
  socketPath = process.env.CONTROLLER_SOCKET ?? '/run/vpn-gateway/controller.sock',
  // Recovery may first repair the active revision and then need a second
  // transactional credential scrub with its own rollback. Keep the client
  // attached long enough for that bounded fail-closed sequence to finish.
  timeoutMs = 300_000,
  maxMessageBytes,
  maxRequestBytes = maxMessageBytes ?? 64 * 1024,
  maxResponseBytes = maxMessageBytes ?? 512 * 1024,
  connect = net.createConnection,
  now = Date.now,
} = {}) {
  if (
    typeof socketPath !== 'string'
    || !socketPath.startsWith('/')
    || socketPath.length > 4096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(socketPath)
  ) {
    throw new TypeError('socketPath must be absolute');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 330_000) {
    throw new TypeError('timeoutMs is invalid');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  for (const [name, value] of [['maxRequestBytes', maxRequestBytes], ['maxResponseBytes', maxResponseBytes]]) {
    if (!Number.isSafeInteger(value) || value < 256 || value > 1024 * 1024) {
      throw new TypeError(`${name} is invalid`);
    }
  }

  const request = (op, fields = {}, {
    requestId = randomUUID(),
    retryTransport = false,
  } = {}) => {
    if (!ALLOWED_OPERATIONS.has(op)) return Promise.reject(new TypeError('operation is not allowed'));
    if (!plainObject(fields) || Object.hasOwn(fields, 'id') || Object.hasOwn(fields, 'op')) {
      return Promise.reject(new TypeError('fields must be a plain object without reserved keys'));
    }
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(requestId)) {
      return Promise.reject(new TypeError('requestId is invalid'));
    }
    if (typeof retryTransport !== 'boolean') {
      return Promise.reject(new TypeError('retryTransport must be a boolean'));
    }

    const id = requestId;
    const startedAt = now();
    if (!Number.isFinite(startedAt)) {
      return Promise.reject(new TypeError('request clock is invalid'));
    }
    const deadline = startedAt + timeoutMs;
    let line;
    try {
      line = `${JSON.stringify({ id, op, ...fields })}\n`;
    } catch {
      return Promise.reject(new TypeError('fields must be JSON serializable'));
    }
    if (Buffer.byteLength(line) > maxRequestBytes) return Promise.reject(new ControlError('INVALID', 400));

    const send = () => new Promise((resolve, reject) => {
      let socket;
      let settled = false;
      let received = Buffer.alloc(0);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        if (error) reject(error);
        else resolve(value);
      };

      const remainingMs = Math.min(timeoutMs, Math.ceil(deadline - now()));
      if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
        finish(transportFailure());
        return;
      }

      try {
        socket = connect({ path: socketPath });
      } catch {
        finish(transportFailure());
        return;
      }
      // A retry shares the original absolute deadline, so two transport
      // attempts can never double the shutdown/request bound.
      socket.setTimeout(remainingMs);
      socket.setNoDelay?.(true);
      socket.once('connect', () => socket.write(line));
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > maxResponseBytes) {
          finish(transportFailure());
          return;
        }
        const newline = received.indexOf(0x0a);
        if (newline < 0) return;
        if (received.subarray(newline + 1).toString('utf8').trim() !== '') {
          finish(transportFailure());
          return;
        }
        let response;
        try {
          response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(received.subarray(0, newline)));
        } catch {
          finish(transportFailure());
          return;
        }
        if (!plainObject(response) || response.id !== id || typeof response.ok !== 'boolean') {
          finish(transportFailure());
          return;
        }
        if (response.ok) {
          finish(null, response.result);
          return;
        }
        const error = plainObject(response.error) ? response.error : {};
        finish(new ControlError(error.code, error.status));
      });
      socket.once('timeout', () => finish(transportFailure()));
      socket.once('error', () => finish(transportFailure()));
      socket.once('end', () => {
        if (!settled) finish(transportFailure());
      });
    });

    return send().catch((error) => {
      if (!retryTransport || error?.transportFailure !== true) throw error;
      return send();
    });
  };

  return Object.freeze({
    request,
    login: (secret) => request('auth.login', { secret }),
    checkSession: (sessionId) => request('auth.check', { sessionId }),
    logout: (sessionId, csrf) => request('auth.logout', { sessionId, csrf }),
    snapshot: (sessionId) => request('admin.snapshot', { sessionId }),
    createUser: (sessionId, csrf, expectedRevision, displayName, operationId) => request('user.create', {
      sessionId, csrf, expectedRevision, displayName,
    }, { requestId: operationId ?? randomUUID(), retryTransport: true }),
    setUserStatus: (sessionId, csrf, expectedRevision, userId, status) => request('user.setStatus', {
      sessionId, csrf, expectedRevision, userId, status,
    }),
    revokeUser: (sessionId, csrf, expectedRevision, userId, confirmName) => request('user.revoke', {
      sessionId, csrf, expectedRevision, userId, confirmName,
    }),
    rotateUserToken: (sessionId, csrf, expectedRevision, userId, operationId) => request('user.rotateToken', {
      sessionId, csrf, expectedRevision, userId,
    }, { requestId: operationId ?? randomUUID(), retryTransport: true }),
    rotateUserCredentials: (sessionId, csrf, expectedRevision, userId, operationId) => request('user.rotateCredentials', {
      sessionId, csrf, expectedRevision, userId,
    }, { requestId: operationId ?? randomUUID(), retryTransport: true }),
    exportUser: (sessionId, userId) => request('user.export', { sessionId, userId }),
    selectExit: (sessionId, csrf, expectedRevision, deviceId) => request('exit.select', {
      sessionId, csrf, expectedRevision, deviceId,
    }),
    addExit: (sessionId, csrf, expectedRevision, deviceId) => request('exit.add', {
      sessionId, csrf, expectedRevision, deviceId,
    }),
    removeExit: (sessionId, csrf, expectedRevision, exitId) => request('exit.remove', {
      sessionId, csrf, expectedRevision, exitId,
    }),
    setPublicBase: (sessionId, csrf, expectedRevision, url) => request('publicBase.set', {
      sessionId, csrf, expectedRevision, url,
    }),
    health: () => request('health.status'),
  });
}
