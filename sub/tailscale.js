// Tailscale 控制逻辑：读取/修改 sing-box 配置中的 tailscale endpoint（tag: ts-out，
// sing-box 1.13 起 tailscale 从 outbound 迁移为 endpoint），
// 以及通过 Tailscale API 拉取可用 Exit Node 列表。均为纯函数，便于单测。

export function maskAuthKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 4) return '****';
  return `****${s.slice(-4)}`;
}

function findTsEndpoint(configObj) {
  const endpoints = Array.isArray(configObj?.endpoints) ? configObj.endpoints : [];
  const ts = endpoints.find((o) => o && o.type === 'tailscale' && o.tag === 'ts-out');
  if (!ts) throw new Error('配置中找不到 tag 为 ts-out 的 tailscale endpoint');
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

// 返回更新后的新配置对象，不修改入参。authKey 为空字符串表示不修改。
export function updateTsOutbound(configObj, { authKey = '', exitNode } = {}) {
  if (!exitNode || !/^[a-zA-Z0-9._-]+$/.test(exitNode)) {
    throw new Error('Exit Node 不能为空，且只能包含字母、数字、点、横线、下划线');
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

// 拉取 tailnet 中宣告了 exit node 能力的设备。失败时返回 []，不抛错。
export async function fetchExitNodes(apiKey, fetchImpl = fetch) {
  try {
    const res = await fetchImpl('https://api.tailscale.com/api/v2/tailnet/-/devices', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn(`Tailscale API 返回 ${res.status}，exit node 列表不可用`);
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
    console.warn(`Tailscale API 请求失败：${err.message}，exit node 列表不可用`);
    return [];
  }
}
