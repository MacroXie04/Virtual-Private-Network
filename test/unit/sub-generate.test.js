import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fromEnv,
  buildVlessLink,
  buildMixed,
  buildSingboxConfig,
  buildClashConfig,
} from '../../sub/generate.js';

const cfg = {
  uuid: '11111111-2222-3333-4444-555555555555',
  host: '203.0.113.10',
  port: 443,
  serverName: 'www.microsoft.com',
  publicKey: 'REALITY_PUBLIC_KEY_BASE64URL',
  shortId: '0123456789abcdef',
  name: 'test-node',
};

test('vless link 包含全部 REALITY 参数', () => {
  const link = buildVlessLink(cfg);
  assert.ok(link.startsWith(`vless://${cfg.uuid}@${cfg.host}:443?`));
  const url = new URL(link);
  assert.equal(url.protocol, 'vless:');
  assert.equal(url.username, cfg.uuid);
  assert.equal(url.hostname, cfg.host);
  assert.equal(url.port, '443');
  const p = url.searchParams;
  assert.equal(p.get('security'), 'reality');
  assert.equal(p.get('flow'), 'xtls-rprx-vision');
  assert.equal(p.get('encryption'), 'none');
  assert.equal(p.get('type'), 'tcp');
  assert.equal(p.get('sni'), cfg.serverName);
  assert.equal(p.get('fp'), 'chrome');
  assert.equal(p.get('pbk'), cfg.publicKey);
  assert.equal(p.get('sid'), cfg.shortId);
  assert.equal(decodeURIComponent(url.hash.slice(1)), cfg.name);
});

test('mixed 格式是链接的 base64 编码', () => {
  const mixed = buildMixed(cfg);
  const decoded = Buffer.from(mixed, 'base64').toString('utf8');
  assert.equal(decoded, buildVlessLink(cfg));
});

test('sing-box 客户端配置含 reality 公钥与正确的 server/port', () => {
  const out = buildSingboxConfig(cfg);
  const proxy = out.outbounds.find((o) => o.type === 'vless');
  assert.ok(proxy);
  assert.equal(proxy.server, cfg.host);
  assert.equal(proxy.server_port, 443);
  assert.equal(proxy.uuid, cfg.uuid);
  assert.equal(proxy.flow, 'xtls-rprx-vision');
  assert.equal(proxy.tls.reality.enabled, true);
  assert.equal(proxy.tls.reality.public_key, cfg.publicKey);
  assert.equal(proxy.tls.reality.short_id, cfg.shortId);
  assert.equal(proxy.tls.server_name, cfg.serverName);
  assert.equal(out.route.final, proxy.tag);
  JSON.stringify(out); // 可序列化
});

test('Clash Meta 配置含 reality-opts 与节点信息', () => {
  const yaml = buildClashConfig(cfg);
  assert.match(yaml, /type: vless/);
  assert.match(yaml, new RegExp(`server: ${cfg.host.replaceAll('.', '\\.')}`));
  assert.match(yaml, /port: 443/);
  assert.match(yaml, /flow: xtls-rprx-vision/);
  assert.match(yaml, /reality-opts:/);
  assert.match(yaml, new RegExp(`public-key: ${cfg.publicKey}`));
  assert.match(yaml, new RegExp(`short-id: ${cfg.shortId}`));
  assert.match(yaml, /MATCH,PROXY/);
});

test('fromEnv 缺变量时报错并列出缺失项', () => {
  assert.throws(() => fromEnv({}), /缺少环境变量: UUID, VPS_HOST, SERVER_NAME, REALITY_PUBLIC_KEY, SHORT_ID/);
});

test('fromEnv 从环境变量构建配置', () => {
  const parsed = fromEnv({
    UUID: cfg.uuid,
    VPS_HOST: cfg.host,
    SERVER_NAME: cfg.serverName,
    REALITY_PUBLIC_KEY: cfg.publicKey,
    SHORT_ID: cfg.shortId,
    NODE_PORT: '8443',
    NODE_NAME: 'my-node',
  });
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.name, 'my-node');
});
