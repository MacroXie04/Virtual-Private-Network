import { plainObject } from './protocol.js';

export class ControlError extends Error {
  constructor(code = 'UNAVAILABLE', status = 503) {
    super('Controller request failed');
    this.name = 'ControlError';
    this.code = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) ? code : 'INTERNAL';
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  }
}

function transportFailure() {
  const error = new ControlError();
  Object.defineProperty(error, 'transportFailure', { value: true });
  return error;
}

export function sendControlRequest({
  connect, socketPath, id, line, timeoutMs, maxResponseBytes, deadline, now,
}) {
  return new Promise((resolve, reject) => {
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
}
