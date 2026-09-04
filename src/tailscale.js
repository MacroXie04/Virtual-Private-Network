import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const DEVICES_URL = 'https://api.tailscale.com/api/v2/tailnet/-/devices';
const DEFAULT_ROUTES = new Set(['0.0.0.0/0', '::/0']);
const MAX_EXIT_NODES = 128;

function safeDeviceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : null;
}

function safeDeviceName(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.endsWith('.') ? value.slice(0, -1) : value;
  if (candidate !== candidate.trim()) return null;
  const name = domainToASCII(candidate).toLowerCase();
  if (!name || name.length > 253) return null;
  const labels = name.split('.');
  return labels.every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  )) ? name : null;
}

function tailscaleIpv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

function tailscaleIpv6(value) {
  return typeof value === 'string'
    && isIP(value) === 6
    && value.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

export class ExitNodeDirectoryError extends Error {
  constructor(message = 'Tailscale exit-node directory is unavailable') {
    super(message);
    this.name = 'ExitNodeDirectoryError';
  }
}

async function readBoundedJson(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ExitNodeDirectoryError();

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ExitNodeDirectoryError();
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    ));
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new ExitNodeDirectoryError();
    return JSON.parse(text);
  }
  throw new ExitNodeDirectoryError();
}

/**
 * Fetch an allow-list of currently authorized, approved exit nodes. Errors are
 * intentionally generic so credentials and remote response bodies never enter
 * logs or HTTP responses.
 */
export async function fetchExitNodes(apiKey, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  maxBytes = 1024 * 1024,
} = {}) {
  if (!apiKey) return [];
  const controller = new AbortController();
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ExitNodeDirectoryError());
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    const response = await Promise.race([
      fetchImpl(DEVICES_URL, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      }),
      timedOut,
    ]);
    if (!response?.ok) throw new ExitNodeDirectoryError();
    const data = await Promise.race([readBoundedJson(response, maxBytes), timedOut]);
    const devices = Array.isArray(data?.devices) ? data.devices : [];

    return devices.slice(0, MAX_EXIT_NODES * 4).flatMap((device) => {
      const advertised = Array.isArray(device?.advertisedRoutes) ? device.advertisedRoutes : [];
      const enabled = Array.isArray(device?.enabledRoutes) ? device.enabledRoutes : [];
      const hasApprovedDefault = advertised.some((route) => (
        DEFAULT_ROUTES.has(route) && enabled.includes(route)
      ));
      const addresses = Array.isArray(device?.addresses) ? device.addresses : [];
      const ipv4 = addresses.find(tailscaleIpv4) ?? null;
      const ipv6 = addresses.find(tailscaleIpv6) ?? null;
      const deviceId = safeDeviceId(device?.id);
      const name = safeDeviceName(device?.hostname ?? device?.name);
      if (!deviceId || !name || !hasApprovedDefault || device.authorized !== true || (!ipv4 && !ipv6)) {
        return [];
      }
      return [{ deviceId, name, ipv4, ipv6 }];
    }).slice(0, MAX_EXIT_NODES);
  } catch (error) {
    if (error instanceof ExitNodeDirectoryError) throw error;
    throw new ExitNodeDirectoryError();
  } finally {
    clearTimeout(timeout);
  }
}

export function selectExitNode(candidates, deviceId) {
  if (!safeDeviceId(deviceId)) {
    throw new Error('An exit-node device must be selected');
  }
  const selected = candidates.find((candidate) => candidate.deviceId === deviceId);
  if (!selected) throw new Error('The selected device is not an approved exit node');
  return {
    deviceId: selected.deviceId,
    name: selected.name,
    address: selected.ipv4 ?? selected.ipv6,
    ipv4: selected.ipv4,
    ipv6: selected.ipv6,
    verifiedAt: new Date().toISOString(),
  };
}
