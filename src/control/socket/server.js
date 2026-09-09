import { chmod, chown, lstat, unlink } from 'node:fs/promises';
import net from 'node:net';
import { safeInteger, absolutePath } from '../app/process-settings.js';
import { assertSocketDirectory, assertSocketPathAbsent } from './files.js';
import { MAX_CONTROL_REQUEST_BYTES, MAX_CONTROL_RESPONSE_BYTES, GENERIC_CONTROL_MESSAGE, safeRequestId, plainObject, errorRecord, responseLine } from './protocol.js';

/**
 * Bounded, one-request-per-connection NDJSON server. Filesystem permissions on
 * the Unix socket are the transport authentication boundary.
 */
export function createControlSocketService({
  controller,
  socketPath,
  socketUid = null,
  socketGid = null,
  socketMode = 0o660,
  timeoutMs = 10_000,
  maxRequestBytes = MAX_CONTROL_REQUEST_BYTES,
  maxResponseBytes = MAX_CONTROL_RESPONSE_BYTES,
  maxConnections = 32,
} = {}) {
  if (!controller || typeof controller.dispatch !== 'function') throw new TypeError('controller is required');
  const normalizedSocketPath = absolutePath(socketPath, 'CONTROLLER_SOCKET');
  for (const [name, value, minimum, maximum] of [
    ['timeoutMs', timeoutMs, 100, 60_000],
    ['maxRequestBytes', maxRequestBytes, 256, 1024 * 1024],
    ['maxResponseBytes', maxResponseBytes, 256, 1024 * 1024],
    ['maxConnections', maxConnections, 1, 1024],
  ]) safeInteger(value, name, { min: minimum, max: maximum });
  if (socketUid !== null) safeInteger(socketUid, 'socketUid');
  if (socketGid !== null) safeInteger(socketGid, 'socketGid');
  if (!Number.isInteger(socketMode) || socketMode < 0o600 || socketMode > 0o770) {
    throw new TypeError('socketMode is invalid');
  }

  const sockets = new Set();
  const dispatchedSockets = new Set();
  let closing = false;
  let boundIdentity = null;
  let serviceClosePromise = null;
  const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: false }, (socket) => {
    sockets.add(socket);
    socket.setTimeout(timeoutMs);
    socket.setNoDelay(true);
    let received = Buffer.alloc(0);
    let handled = false;

    const finish = (value) => {
      if (socket.destroyed) return;
      socket.end(responseLine(value, maxResponseBytes));
    };
    const reject = (id = null, code = 'INVALID', status = 400) => {
      if (handled) return;
      handled = true;
      finish({ id, ok: false, error: { code, message: GENERIC_CONTROL_MESSAGE, status } });
    };

    socket.on('data', (chunk) => {
      if (handled || closing) {
        socket.destroy();
        return;
      }
      if (received.length + chunk.length > maxRequestBytes) {
        reject(null, 'REQUEST_TOO_LARGE', 400);
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      if (received.subarray(newline + 1).toString('utf8').trim() !== '') {
        reject();
        return;
      }
      handled = true;
      socket.pause();
      socket.setTimeout(0);
      let request;
      try {
        request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(received.subarray(0, newline)));
      } catch {
        finish({ id: null, ok: false, error: { code: 'INVALID', message: GENERIC_CONTROL_MESSAGE, status: 400 } });
        return;
      }
      const id = safeRequestId(request?.id);
      if (!plainObject(request) || id === null) {
        finish({ id, ok: false, error: { code: 'INVALID', message: GENERIC_CONTROL_MESSAGE, status: 400 } });
        return;
      }
      dispatchedSockets.add(socket);
      Promise.resolve().then(() => controller.dispatch(request)).then(
        (result) => finish({ id, ok: true, result }),
        (error) => finish({ id, ok: false, error: errorRecord(error) }),
      );
    });
    socket.once('timeout', () => reject(null, 'TIMEOUT', 408));
    socket.once('error', () => {});
    socket.once('close', () => {
      sockets.delete(socket);
      dispatchedSockets.delete(socket);
    });
  });
  server.maxConnections = maxConnections;

  return {
    server,
    socketPath: normalizedSocketPath,
    async listen() {
      if (closing) throw new Error('controller socket service is closing');
      if (server.listening) return;
      await assertSocketDirectory(normalizedSocketPath, socketUid);
      await assertSocketPathAbsent(normalizedSocketPath);
      try {
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
          server.listen(normalizedSocketPath);
        });
        const initialStat = await lstat(normalizedSocketPath);
        if (!initialStat.isSocket()) throw new Error('controller socket path is unsafe');
        boundIdentity = { dev: initialStat.dev, ino: initialStat.ino };
        if (socketUid !== null || socketGid !== null) {
          await chown(normalizedSocketPath, socketUid ?? -1, socketGid ?? -1);
        }
        await chmod(normalizedSocketPath, socketMode);
        const stat = await lstat(normalizedSocketPath);
        if (!stat.isSocket() || stat.dev !== boundIdentity.dev || stat.ino !== boundIdentity.ino) {
          throw new Error('controller socket path changed during setup');
        }
      } catch (error) {
        if (server.listening) {
          for (const socket of sockets) socket.destroy();
          await new Promise((resolve) => server.close(resolve));
        }
        const stat = await lstat(normalizedSocketPath).catch(() => null);
        if (stat?.isSocket()
          && boundIdentity !== null
          && stat.dev === boundIdentity.dev
          && stat.ino === boundIdentity.ino) {
          await unlink(normalizedSocketPath).catch(() => {});
        }
        throw error;
      }
    },
    close() {
      if (serviceClosePromise) return serviceClosePromise;
      closing = true;
      serviceClosePromise = (async () => {
        // Drop idle or partially framed peers, but let every fully accepted
        // request send its response. This is essential for create/rotate,
        // whose raw token is intentionally returned exactly once.
        for (const socket of sockets) {
          if (!dispatchedSockets.has(socket)) socket.destroy();
        }
        if (server.listening) {
          await new Promise((resolve) => server.close(resolve));
        }
        const stat = await lstat(normalizedSocketPath).catch((error) => {
          if (error?.code === 'ENOENT') return null;
          throw error;
        });
        if (stat !== null
          && stat.isSocket()
          && boundIdentity !== null
          && stat.dev === boundIdentity.dev
          && stat.ino === boundIdentity.ino) {
          await unlink(normalizedSocketPath);
        }
        boundIdentity = null;
      })();
      return serviceClosePromise;
    },
  };
}
