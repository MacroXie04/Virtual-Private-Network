import { createHash } from 'node:crypto';
import http from 'node:http';

export function tokenHash(token) {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

export function request(address, requestPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: address.port, path: requestPath, method,
      headers: { Host: 'sub.example.com', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

export function projection(token, displayName = 'Alice') {
  return {
    schemaVersion: 2,
    revision: 1,
    gateway: {
      vpnPublicHostname: 'vpn.example.com',
      subscriptionPublicHostname: 'sub.example.com',
      port: 443,
      websocketPath: `/${'A'.repeat(43)}`,
    },
    users: [{
      id: 'alice',
      displayName,
      uuid: '123e4567-e89b-42d3-a456-426614174000',
      tokenHash: tokenHash(token),
    }],
  };
}
