import net from 'node:net';

export const SOCKS_VERSION = 0x05;
export const USERNAME_PASSWORD_METHOD = 0x02;
export const USERNAME_PASSWORD_VERSION = 0x01;
export const MAX_HANDSHAKE_BYTES = 1024;

export function encodeCredentials(username, password) {
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

export function encodeTarget(host, port) {
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

export function expectedReplyLength(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== SOCKS_VERSION) throw new Error('Health proxy returned an invalid SOCKS version');
  if (buffer[1] !== 0x00) throw new Error(`Health proxy could not reach the target (SOCKS status ${buffer[1]})`);
  if (buffer[2] !== 0x00) throw new Error('Health proxy returned an invalid SOCKS response');
  if (buffer[3] === 0x01) return 10;
  if (buffer[3] === 0x04) return 22;
  if (buffer[3] === 0x03) return buffer.length < 5 ? null : 7 + buffer[4];
  throw new Error('Health proxy returned an invalid address type');
}
