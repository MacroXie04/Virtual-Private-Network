import { deriveExitUuid } from '../identity/exit-profiles.js';
import { validateState } from '../model/state.js';
import { buildSubscriptionView, validateSubscriptionView } from './view.js';
import { ValidationError, safeYamlScalar } from '../validation/values.js';

function resolveConnections(value, selector) {
  let source;
  if (value?.schemaVersion === 3) {
    const state = validateState(value);
    source = buildSubscriptionView(state);
  } else {
    source = validateSubscriptionView(value);
  }
  const id = typeof selector === 'string' ? selector : selector?.id;
  const user = source.users.find((candidate) => candidate.id === id);
  if (!user) throw new ValidationError('user', 'must identify an active user');
  const connection = {
    uuid: user.uuid,
    name: user.displayName,
    host: source.gateway.vpnPublicHostname,
    port: source.gateway.port,
    websocketPath: source.gateway.websocketPath,
  };
  if ((source.exits?.length ?? 0) === 0) return [connection];
  return [
    { ...connection, name: 'Default' },
    ...source.exits.map((exit) => ({
      ...connection, uuid: deriveExitUuid(user.uuid, exit.id), name: exit.name,
    })),
  ];
}

function connectionLink(config) {
  const query = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: config.host,
    type: 'ws',
    host: config.host,
    path: config.websocketPath,
  });
  return `vless://${config.uuid}@${config.host}:${config.port}?${query}#${encodeURIComponent(config.name)}`;
}

export function renderVlessLink(value, selector) {
  return connectionLink(resolveConnections(value, selector)[0]);
}

export function renderVlessLinks(value, selector) {
  return resolveConnections(value, selector).map(connectionLink);
}

export function renderSingBoxClientConfig(value, selector) {
  const connections = resolveConnections(value, selector);
  const multiple = connections.length > 1;
  const finalTag = multiple ? 'PROXY' : 'proxy';
  return {
    log: { level: 'info', timestamp: true },
    inbounds: [{
      type: 'mixed',
      tag: 'mixed-in',
      listen: '127.0.0.1',
      listen_port: 7890,
    }],
    outbounds: [
      ...(multiple ? [{
        type: 'selector', tag: finalTag, outbounds: connections.map((connection) => connection.name),
        default: 'Default',
      }] : []),
      ...connections.map((config) => ({
        type: 'vless',
        tag: multiple ? config.name : 'proxy',
        server: config.host,
        server_port: config.port,
        uuid: config.uuid,
        tls: {
          enabled: true,
          server_name: config.host,
        },
        transport: {
          type: 'ws',
          path: config.websocketPath,
          headers: { Host: config.host },
        },
      })),
    ],
    route: { final: finalTag },
  };
}

export function renderClashClientConfig(value, selector) {
  const connections = resolveConnections(value, selector);
  const quote = safeYamlScalar;
  return `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
proxies:
${connections.map((config) => `  - name: ${quote(config.name)}
    type: vless
    server: ${quote(config.host)}
    port: ${config.port}
    uuid: ${quote(config.uuid)}
    network: ws
    udp: true
    tls: true
    servername: ${quote(config.host)}
    ws-opts:
      path: ${quote(config.websocketPath)}
      headers:
        Host: ${quote(config.host)}`).join('\n')}
proxy-groups:
  - name: PROXY
    type: select
    proxies:
${connections.map((config) => `      - ${quote(config.name)}`).join('\n')}
rules:
  - MATCH,PROXY
`;
}

export function renderMixedSubscription(value, selector) {
  return Buffer.from(`${renderVlessLinks(value, selector).join('\n')}\n`, 'utf8').toString('base64');
}

export function renderClientSubscription(value, selector, format = 'links') {
  if (format === 'links') return `${renderVlessLinks(value, selector).join('\n')}\n`;
  if (format === 'mixed') return renderMixedSubscription(value, selector);
  if (format === 'sing-box' || format === 'singbox') {
    return `${JSON.stringify(renderSingBoxClientConfig(value, selector), null, 2)}\n`;
  }
  if (format === 'clash') return renderClashClientConfig(value, selector);
  throw new ValidationError('format', 'must be links, mixed, sing-box, or clash');
}

export const buildVlessLink = renderVlessLink;
export const buildSingBoxClientConfig = renderSingBoxClientConfig;
export const buildClashClientConfig = renderClashClientConfig;
export const buildMixedSubscription = renderMixedSubscription;
