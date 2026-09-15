import http2 from 'node:http2';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Prefix a message with the 5-byte gRPC frame header (uncompressed). */
export function frameMessage(message) {
  if (!Buffer.isBuffer(message)) throw new TypeError('message must be a buffer');
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

/** Split a response body into its framed messages; compressed frames are refused. */
export function unframeMessages(body) {
  const messages = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 5 > body.length) throw new Error('truncated gRPC frame header');
    if (body[offset] !== 0) throw new Error('compressed gRPC frames are not supported');
    const length = body.readUInt32BE(offset + 1);
    const end = offset + 5 + length;
    if (end > body.length) throw new Error('truncated gRPC frame');
    messages.push(body.subarray(offset + 5, end));
    offset = end;
  }
  return messages;
}

/**
 * One unary gRPC call over plaintext HTTP/2 to a loopback service. Resolves
 * with the response messages; any transport or non-zero gRPC status rejects.
 */
export function grpcUnary({ host, port, method, message, timeoutMs = 3_000, connect = http2.connect }) {
  if (typeof host !== 'string' || !Number.isInteger(port) || typeof method !== 'string' || !method.startsWith('/')) {
    throw new TypeError('gRPC call requires host, port and method');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('timeoutMs is invalid');
  return new Promise((resolve, reject) => {
    const session = connect(`http://${host}:${port}`);
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        session.destroy();
        reject(error);
      } else {
        session.close();
        resolve(value);
      }
    };
    timer = setTimeout(() => finish(new Error('gRPC call timed out')), timeoutMs);
    timer.unref?.();
    session.once('error', (error) => finish(error));
    const request = session.request({
      ':method': 'POST',
      ':path': method,
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    const chunks = [];
    let received = 0;
    let status = null;
    const readStatus = (headers) => {
      if (headers['grpc-status'] !== undefined) status = String(headers['grpc-status']);
    };
    request.once('response', (headers) => {
      if (headers[':status'] !== 200) {
        finish(new Error(`gRPC transport status ${headers[':status']}`));
        return;
      }
      readStatus(headers);
    });
    request.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) {
        finish(new Error('gRPC response too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('trailers', readStatus);
    request.once('error', (error) => finish(error));
    request.once('end', () => {
      if (status !== '0') {
        finish(new Error(`gRPC status ${status ?? 'missing'}`));
        return;
      }
      try {
        finish(null, unframeMessages(Buffer.concat(chunks)));
      } catch (error) {
        finish(error);
      }
    });
    request.end(frameMessage(message));
  });
}
