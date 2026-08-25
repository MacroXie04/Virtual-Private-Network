import { pathToFileURL } from 'node:url';

// 节点配置：{ uuid, host, port, serverName, publicKey, shortId, name }

export function fromEnv(env = process.env) {
  const required = ['UUID', 'VPS_HOST', 'SERVER_NAME', 'REALITY_PUBLIC_KEY', 'SHORT_ID'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }
  return {
    uuid: env.UUID,
    host: env.VPS_HOST,
    port: Number(env.NODE_PORT ?? 443),
    serverName: env.SERVER_NAME,
    publicKey: env.REALITY_PUBLIC_KEY,
    shortId: env.SHORT_ID,
    name: env.NODE_NAME ?? 'vps-reality',
  };
}

export function buildVlessLink(cfg) {
  const params = new URLSearchParams({
    encryption: 'none',
    flow: 'xtls-rprx-vision',
    security: 'reality',
    sni: cfg.serverName,
    fp: 'chrome',
    pbk: cfg.publicKey,
    sid: cfg.shortId,
    type: 'tcp',
  });
  return `vless://${cfg.uuid}@${cfg.host}:${cfg.port}?${params}#${encodeURIComponent(cfg.name)}`;
}

export function buildShareLinks(cfg) {
  return [buildVlessLink(cfg)];
}

export function buildMixed(cfg) {
  return Buffer.from(buildShareLinks(cfg).join('\n'), 'utf8').toString('base64');
}

export function buildSingboxConfig(cfg) {
  return {
    log: { level: 'info', timestamp: true },
    inbounds: [
      {
        type: 'mixed',
        tag: 'in',
        listen: '127.0.0.1',
        listen_port: 7890,
      },
    ],
    outbounds: [
      {
        type: 'vless',
        tag: cfg.name,
        server: cfg.host,
        server_port: cfg.port,
        uuid: cfg.uuid,
        flow: 'xtls-rprx-vision',
        tls: {
          enabled: true,
          server_name: cfg.serverName,
          utls: { enabled: true, fingerprint: 'chrome' },
          reality: {
            enabled: true,
            public_key: cfg.publicKey,
            short_id: cfg.shortId,
          },
        },
      },
      { type: 'direct', tag: 'direct' },
    ],
    route: { final: cfg.name },
  };
}

export function buildClashConfig(cfg) {
  return `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
proxies:
  - name: ${cfg.name}
    type: vless
    server: ${cfg.host}
    port: ${cfg.port}
    uuid: ${cfg.uuid}
    network: tcp
    udp: true
    tls: true
    flow: xtls-rprx-vision
    servername: ${cfg.serverName}
    client-fingerprint: chrome
    reality-opts:
      public-key: ${cfg.publicKey}
      short-id: ${cfg.shortId}
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - ${cfg.name}
rules:
  - MATCH,PROXY
`;
}

const formats = {
  links: buildShareLinks,
  mixed: buildMixed,
  singbox: (cfg) => JSON.stringify(buildSingboxConfig(cfg), null, 2),
  clash: buildClashConfig,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const format = process.argv[2] ?? 'links';
  try {
    const cfg = fromEnv();
    if (!(format in formats)) {
      console.error(`未知格式 "${format}"，可用: ${Object.keys(formats).join(', ')}`);
      process.exit(1);
    }
    const out = formats[format](cfg);
    console.log(Array.isArray(out) ? out.join('\n') : out);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
