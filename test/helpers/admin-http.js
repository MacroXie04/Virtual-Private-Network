import http from 'node:http';

export function request(address, requestPath, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { host: 'admin.test', ...headers };
    if (body && !Object.hasOwn(requestHeaders, 'content-length')) {
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: requestPath,
      method,
      headers: requestHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function cookieValue(setCookie, name) {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  const row = values.find((value) => value?.startsWith(`${name}=`));
  return row?.split(';', 1)[0];
}

export function encoded(values) {
  return new URLSearchParams(values).toString();
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
