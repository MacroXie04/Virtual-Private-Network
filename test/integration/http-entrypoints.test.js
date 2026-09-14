import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function availablePort() {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

function request(port, route, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: route, agent: false,
      headers: { host }, timeout: 500,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('HTTP entry point did not respond')));
    req.on('error', reject);
  });
}

for (const spec of [
  { name: 'admin', portVariable: 'ADMIN_PORT', route: '/login', host: 'admin.example.com', status: 200 },
  { name: 'subscription', portVariable: 'SUB_PORT', route: '/', host: 'sub.example.com', status: 404 },
]) {
  test(`${spec.name} executable serves HTTP and exits cleanly on SIGTERM`, { timeout: 10_000 }, async (t) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vpn-http-entry-'));
    const port = await availablePort();
    const child = spawn(process.execPath, [fileURLToPath(new URL(
      `../../src/http/${spec.name}-server.js`, import.meta.url,
    ))], {
      cwd: dataDir,
      env: { DATA_DIR: dataDir, ADMIN_PUBLIC_HOSTNAME: 'admin.example.com', [spec.portVariable]: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const closed = once(child, 'close');
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await rm(dataDir, { recursive: true, force: true });
    });
    let response;
    const deadline = Date.now() + 5_000;
    while (!response && Date.now() < deadline) {
      assert.equal(child.exitCode, null, stderr || 'HTTP entry point exited before listening');
      response = await request(port, spec.route, spec.host).catch(() => null);
      if (!response) await delay(25);
    }
    assert.ok(response, stderr || 'HTTP entry point did not start');
    assert.equal(response.status, spec.status);
    assert.equal(response.headers['cache-control'], 'no-store');
    if (spec.name === 'admin') {
      assert.match(response.headers['content-type'], /^text\/html/u);
      assert.match(response.body, /<form/u);
    }
    child.kill('SIGTERM');
    assert.deepEqual(await closed, [0, null]);
  });
}
