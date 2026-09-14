export const MAX_CONTROL_REQUEST_BYTES = 64 * 1024;
export const MAX_CONTROL_RESPONSE_BYTES = 512 * 1024;
export const GENERIC_CONTROL_MESSAGE = 'Controller request failed';

export function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function safeRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/u.test(value) ? value : null;
}

export function errorRecord(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(error.code)
    ? error.code
    : 'INTERNAL';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  return { code, message: GENERIC_CONTROL_MESSAGE, status };
}

export function responseLine(value, maxBytes) {
  let line;
  try {
    line = `${JSON.stringify(value)}\n`;
  } catch {
    line = `{"id":null,"ok":false,"error":{"code":"INTERNAL","message":"${GENERIC_CONTROL_MESSAGE}","status":500}}\n`;
  }
  if (Buffer.byteLength(line) > maxBytes) {
    return `{"id":null,"ok":false,"error":{"code":"RESPONSE_TOO_LARGE","message":"${GENERIC_CONTROL_MESSAGE}","status":500}}\n`;
  }
  return line;
}
