import net from 'node:net';

const SOCKS_VERSION = 0x05;
const USERNAME_PASSWORD_METHOD = 0x02;
const USERNAME_PASSWORD_VERSION = 0x01;
const MAX_HANDSHAKE_BYTES = 1024;

function encodeCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new Error('Health proxy credentials are invalid');
  }
  const encodedUsername = Buffer.from(username, 'utf8');
  const encodedPassword = Buffer.from(password, 'utf8');
  if (
    encodedUsername.length < 1
    || encodedUsername.length > 255
    || encodedPassword.length < 1
    || encodedPassword.length > 255
  ) {
    throw new Error('Health proxy credentials are invalid');
  }
  return Buffer.concat([
    Buffer.from([USERNAME_PASSWORD_VERSION, encodedUsername.length]),
    encodedUsername,
    Buffer.from([encodedPassword.length]),
    encodedPassword,
  ]);
}

function encodeTarget(host, port) {
  const family = net.isIP(host);
  let address;
  let type;

  if (family === 4) {
    type = 0x01;
    address = Buffer.from(host.split('.').map(Number));
  } else if (family === 6) {
    type = 0x04;
    const normalized = normalizeIpv6(host);
    address = Buffer.alloc(16);
    normalized.forEach((part, index) => address.writeUInt16BE(part, index * 2));
  } else {
    const encoded = Buffer.from(host, 'utf8');
    if (encoded.length === 0 || encoded.length > 255) {
      throw new Error('Health target hostname is invalid');
    }
    type = 0x03;
    address = Buffer.concat([Buffer.from([encoded.length]), encoded]);
  }

  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([SOCKS_VERSION, 0x01, 0x00, type]), address, portBytes]);
}

function normalizeIpv6(address) {
  const [headText, tailText = ''] = address.toLowerCase().split('::');
  if (address.split('::').length > 2) throw new Error('Health target IPv6 address is invalid');

  const parseParts = (text) => {
    if (!text) return [];
    const raw = text.split(':');
    const parts = [];
    for (const part of raw) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
          throw new Error('Health target IPv6 address is invalid');
        }
        parts.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        const value = Number.parseInt(part, 16);
        if (!/^[0-9a-f]{1,4}$/.test(part) || value > 0xffff) {
          throw new Error('Health target IPv6 address is invalid');
        }
        parts.push(value);
      }
    }
    return parts;
  };

  const head = parseParts(headText);
  const tail = parseParts(tailText);
  const omitted = 8 - head.length - tail.length;
  if ((address.includes('::') && omitted < 1) || (!address.includes('::') && omitted !== 0)) {
    throw new Error('Health target IPv6 address is invalid');
  }
  return [...head, ...Array(omitted).fill(0), ...tail];
}

function expectedReplyLength(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== SOCKS_VERSION) throw new Error('Health proxy returned an invalid SOCKS version');
  if (buffer[1] !== 0x00) throw new Error(`Health proxy could not reach the target (SOCKS status ${buffer[1]})`);
  if (buffer[2] !== 0x00) throw new Error('Health proxy returned an invalid SOCKS response');
  if (buffer[3] === 0x01) return 10;
  if (buffer[3] === 0x04) return 22;
  if (buffer[3] === 0x03) return buffer.length < 5 ? null : 7 + buffer[4];
  throw new Error('Health proxy returned an invalid address type');
}

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
