import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPage } from '../../sub/page.js';
import { buildVlessLink } from '../../sub/generate.js';

const cfg = {
  uuid: '11111111-2222-3333-4444-555555555555',
  host: '203.0.113.10',
  port: 443,
  serverName: 'www.microsoft.com',
  publicKey: 'REALITY_PUBLIC_KEY_BASE64URL',
  shortId: '0123456789abcdef',
  name: 'test-node',
};
const base = 'http://203.0.113.10:8080/TOKEN123';

test('页面包含节点信息与分享链接', () => {
  const html = buildPage(cfg, base);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes(cfg.uuid));
  assert.ok(html.includes(cfg.host));
  assert.ok(html.includes(cfg.publicKey));
  assert.ok(html.includes(buildVlessLink(cfg)));
  assert.match(html, /<title>test-node<\/title>/);
});

test('页面包含三种订阅地址与下载入口', () => {
  const html = buildPage(cfg, base);
  assert.ok(html.includes(`${base}/singbox`));
  assert.ok(html.includes(`${base}/clash`));
  assert.ok(html.includes(`data-copy="${base}"`));
  assert.match(html, /download="singbox-config\.json"/);
  assert.match(html, /download="clash-config\.yaml"/);
});

test('页面正确转义 HTML 特殊字符', () => {
  const evil = { ...cfg, name: '<script>alert(1)</script>' };
  const html = buildPage(evil, base);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
