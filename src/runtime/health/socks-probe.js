import net from 'node:net';
import {
  SOCKS_VERSION, USERNAME_PASSWORD_METHOD, USERNAME_PASSWORD_VERSION, MAX_HANDSHAKE_BYTES,
  encodeCredentials, encodeTarget, expectedReplyLength,
} from './socks-codec.js';

/**
 * Prove that the local health-only SOCKS inbound can open a connection to the
 * configured target. The server renderer routes this inbound exclusively to
 * ts-out, so a successful handshake is an end-to-end fail-closed readiness
 * signal rather than a process-alive check.
 */
export function probeSocksConnect({
  proxyHost = '127.0.0.1',
  proxyPort,
  username,
  password,
  targetHost,
  targetPort,
  timeoutMs = 8000,
  connect = net.createConnection,
}) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    return Promise.reject(new Error('Health proxy port is invalid'));
  }
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return Promise.reject(new Error('Health target port is invalid'));
  }

  let authRequest;
  let connectRequest;
  try {
    authRequest = encodeCredentials(username, password);
    connectRequest = encodeTarget(targetHost, targetPort);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxyHost, port: proxyPort });
    let stage = 'greeting';
    let received = Buffer.alloc(0);
    let settled = false;
    let timer;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(true);
    };

    timer = setTimeout(() => finish(new Error('Health probe timed out')), timeoutMs);
    timer.unref?.();

    socket.once('error', () => finish(new Error('Health proxy is unavailable')));
    socket.once('connect', () => socket.write(Buffer.from([
      SOCKS_VERSION,
      0x01,
      USERNAME_PASSWORD_METHOD,
    ])));
    socket.on('data', (chunk) => {
      if (received.length + chunk.length > MAX_HANDSHAKE_BYTES) {
        finish(new Error('Health proxy returned an oversized SOCKS response'));
        return;
      }
      received = Buffer.concat([received, chunk]);
      try {
        while (!settled) {
          if (stage === 'greeting') {
            if (received.length < 2) return;
            if (received[0] !== SOCKS_VERSION || received[1] !== USERNAME_PASSWORD_METHOD) {
              throw new Error('Health proxy rejected the required SOCKS authentication method');
            }
            received = received.subarray(2);
            stage = 'authentication';
            socket.write(authRequest);
            continue;
          }
          if (stage === 'authentication') {
            if (received.length < 2) return;
            if (received[0] !== USERNAME_PASSWORD_VERSION || received[1] !== 0x00) {
              throw new Error('Health proxy rejected the health credentials');
            }
            received = received.subarray(2);
            stage = 'connect';
            socket.write(connectRequest);
            continue;
          }
          if (stage === 'connect') {
            const length = expectedReplyLength(received);
            if (length === null || received.length < length) return;
            finish();
            return;
          }
          throw new Error('Health probe entered an invalid SOCKS state');
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.once('close', () => {
      if (!settled) finish(new Error('Health proxy closed the connection'));
    });
  });
}
