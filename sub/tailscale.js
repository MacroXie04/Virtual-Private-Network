// Tailscale control logic: read/modify the tailscale endpoint in the sing-box config
// (tag: ts-out — since sing-box 1.13, tailscale moved from an outbound to an endpoint),
// and fetch the list of available Exit Nodes via the Tailscale API.
// All pure functions, easy to unit test.

export function maskAuthKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 4) return '****';
  return `****${s.slice(-4)}`;
}

function findTsEndpoint(configObj) {
  const endpoints = Array.isArray(configObj?.endpoints) ? configObj.endpoints : [];
  const ts = endpoints.find((o) => o && o.type === 'tailscale' && o.tag === 'ts-out');
  if (!ts) throw new Error('No tailscale endpoint with tag ts-out found in the config');
  return ts;
}

export function parseTsOutbound(configObj) {
  const ts = findTsEndpoint(configObj);
  return {
    exitNode: ts.exit_node ?? '',
    hasAuthKey: Boolean(ts.auth_key),
    maskedAuthKey: maskAuthKey(ts.auth_key),
    hostname: ts.hostname ?? '',
  };
}

// Returns a new, updated config object without mutating the input. An empty authKey means "keep unchanged".
export function updateTsOutbound(configObj, { authKey = '', exitNode } = {}) {
  if (!exitNode || !/^[a-zA-Z0-9._-]+$/.test(exitNode)) {
    throw new Error('Exit Node must not be empty and may only contain letters, digits, dots, hyphens, and underscores');
  }
  findTsEndpoint(configObj);
  const endpoints = configObj.endpoints.map((o) => {
    if (o && o.type === 'tailscale' && o.tag === 'ts-out') {
      const next = { ...o, exit_node: exitNode };
      if (authKey) next.auth_key = authKey;
      return next;
    }
    return o;
  });
  return { ...configObj, endpoints };
}

// Fetch devices in the tailnet that advertise exit node capability. Returns [] on failure; never throws.
export async function fetchExitNodes(apiKey, fetchImpl = fetch) {
  try {
    const res = await fetchImpl('https://api.tailscale.com/api/v2/tailnet/-/devices', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn(`Tailscale API returned ${res.status}; exit node list unavailable`);
      return [];
    }
    const data = await res.json();
    const devices = Array.isArray(data?.devices) ? data.devices : [];
    return devices
      .filter((d) => {
        const routes = Array.isArray(d?.advertisedRoutes) ? d.advertisedRoutes : [];
        return routes.includes('0.0.0.0/0') || routes.includes('::/0');
      })
      .map((d) => ({
        name: String(d.hostname ?? d.name ?? ''),
        ip: (Array.isArray(d.addresses) ? d.addresses : []).find((a) => String(a).startsWith('100.')) ?? '',
      }))
      .filter((d) => d.ip);
  } catch (err) {
    console.warn(`Tailscale API request failed: ${err.message}; exit node list unavailable`);
    return [];
  }
}
