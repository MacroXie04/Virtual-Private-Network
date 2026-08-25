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

test('page contains node info and share link', () => {
  const html = buildPage(cfg, base);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes(cfg.uuid));
  assert.ok(html.includes(cfg.host));
  assert.ok(html.includes(cfg.publicKey));
  assert.ok(html.includes(buildVlessLink(cfg)));
  assert.match(html, /<title>test-node<\/title>/);
});

test('page contains three subscription URLs and download links', () => {
  const html = buildPage(cfg, base);
  assert.ok(html.includes(`${base}/singbox`));
  assert.ok(html.includes(`${base}/clash`));
  assert.ok(html.includes(`data-copy="${base}"`));
  assert.match(html, /download="singbox-config\.json"/);
  assert.match(html, /download="clash-config\.yaml"/);
});

test('page escapes HTML special characters', () => {
  const evil = { ...cfg, name: '<script>alert(1)</script>' };
  const html = buildPage(evil, base);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('Tailscale card renders status, form, and datalist', () => {
  const tsState = {
    service: 'active',
    exitNode: '100.64.0.1',
    hasAuthKey: true,
    maskedAuthKey: '****3456',
    hostname: 'proxy-vps',
    exitNodes: [{ name: 'home-exit', ip: '100.64.0.2' }],
    logs: 'tailscale: logged in as proxy-vps',
    flash: '',
  };
  const html = buildPage(cfg, base, tsState);
  assert.ok(html.includes(`action="${base}/tailscale"`));
  assert.ok(html.includes('name="authKey"'));
  assert.ok(html.includes('name="exitNode"'));
  assert.ok(html.includes('value="100.64.0.1"'));
  assert.ok(html.includes('<option value="100.64.0.2" label="home-exit">'));
  assert.ok(html.includes('****3456'));
  assert.ok(html.includes('tailscale: logged in as proxy-vps'));
  assert.ok(!html.includes('class="flash'));
});

test('Tailscale card renders success and error banners, with the error message escaped', () => {
  const ok = buildPage(cfg, base, { flash: 'ok' });
  assert.ok(ok.includes('Saved'));

  const err = buildPage(cfg, base, { flash: 'err:<b>bad</b>' });
  assert.ok(err.includes('&lt;b&gt;bad&lt;/b&gt;'));
  assert.ok(!err.includes('<b>bad</b>'));
});

test('Tailscale card tolerates empty state', () => {
  const html = buildPage(cfg, base);
  assert.ok(html.includes('Tailscale Exit'));
  assert.ok(!html.includes('<pre class="logs">'));
});
