// Run with the built gateway image, without network access:
// docker run --rm --network none --read-only --tmpfs /tmp \
//   --cap-drop ALL --security-opt no-new-privileges \
//   --mount type=bind,src="$PWD",dst=/workspace,readonly \
//   --entrypoint node IMAGE /workspace/test/ci/verify-client-exits.js
//
// This exercises the real sing-box VLESS, WebSocket, authenticated-user routes,
// and private-address rejection. Only the Tailscale endpoints are replaced by
// local SOCKS witnesses. It does not test Tailscale enrollment or Cloudflare.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { renderSingBoxClientConfig } from '../../src/core/client-subscriptions.js';
import { renderSingBoxConfig } from '../../src/core/server-render.js';
import { deriveExitUuid, exitProfileId } from '../../src/core/exit-profiles.js';
import { probeSocksConnect } from '../../src/runtime/health-probe.js';
import { FIXTURE_TIME, fixtureState, fixtureUser } from '../fixtures/state.js';

const binary = process.env.SINGBOX_BIN || '/usr/local/bin/sing-box';
const version = spawnSync(binary, ['version'], { encoding: 'utf8' });
assert.equal(version.status, 0, version.stderr || version.error?.message);
assert.match(version.stdout, /^sing-box version 1\.13\.21$/mu);

const directory = await mkdtemp(join(tmpdir(), 'vpn-client-exits-'));
const configPath = join(directory, 'sing-box.json');
const exit = {
  id: exitProfileId('test-extra-exit'),
  name: 'additional-test-exit',
  address: '100.64.0.3',
  authKey: null,
};
const state = fixtureState();
state.tailscale.stateDirectory = join(directory, 'tailscale');
state.tailscale.extraExits = [exit];
state.users.push(fixtureUser({
  id: 'bob', displayName: 'Bob',
  uuid: '00000000-0000-4000-8000-000000000002',
  tokenHash: `sha256:${'2'.repeat(64)}`,
}));
const identities = state.users.map((user) => ({
  id: user.id,
  defaultUuid: user.uuid,
  extraUuid: deriveExitUuid(user.uuid, exit.id),
}));
let child;
let childOutput = '';
let childError;
let checks = 0;
const witnesses = [];

async function witness(name) {
  const connections = new Set();
  const hits = [];
  const marker = `EXIT:${name}\n`;
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) return socket.destroy();
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, 2 + buffer[1]).includes(0)) {
          return socket.destroy();
        }
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buffer.length < 10) return;
        if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[3] !== 1) {
          return socket.destroy();
        }
        hits.push({ host: [...buffer.subarray(4, 8)].join('.'), port: buffer.readUInt16BE(8) });
        buffer = buffer.subarray(10);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        stage = 'payload';
      }
      if (stage === 'payload' && buffer.length > 0) {
        stage = 'done';
        socket.end(Buffer.concat([Buffer.from(marker), buffer]));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = {
    name, marker, hits, port: server.address().port,
    async stop() {
      for (const socket of connections) socket.destroy();
      if (server.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    },
  };
  witnesses.push(result);
  return result;
}

async function stopSingBox() {
  if (!child) return;
  const process = child;
  child = undefined;
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  process.kill('SIGTERM');
  const timer = setTimeout(() => process.kill('SIGKILL'), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

function reachable(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(200, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function startSingBox(value) {
  await stopSingBox();
  const config = renderSingBoxConfig(value);
  const endpointTags = config.endpoints.map((endpoint) => endpoint.tag);
  assert.equal(endpointTags.length, witnesses.length);
  // Keep the application-rendered inbounds, resolver detours, and rules intact.
  // The substitute outbounds only record CONNECT destinations; they never dial.
  delete config.endpoints;
  config.outbounds = endpointTags.map((tag, index) => ({
    type: 'socks', tag, server: '127.0.0.1', server_port: witnesses[index].port, version: '5',
  }));
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const checked = spawnSync(binary, ['check', '-c', configPath], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
  childOutput = '';
  childError = undefined;
  child = spawn(binary, ['run', '-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (error) => { childError = error; });
  const capture = (data) => { childOutput = `${childOutput}${data}`.slice(-20_000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (childError) throw childError;
    assert.equal(child.exitCode, null, childOutput);
    if (await reachable(config.inbounds[0].listen_port)) return config;
    await delay(25);
  }
  throw new Error(`sing-box did not listen: ${childOutput}`);
}

function vlessRequest(uuid, host, port) {
  const destinationPort = Buffer.alloc(2);
  destinationPort.writeUInt16BE(port);
  return Buffer.concat([
    Buffer.from([0]), Buffer.from(uuid.replaceAll('-', ''), 'hex'),
    Buffer.from([0, 1]), destinationPort, Buffer.from([1]),
    Buffer.from(host.split('.').map(Number)), Buffer.from('client-exit-test'),
  ]);
}

async function connectVless(uuid, host = '8.8.8.8', port = 443) {
  const ws = new WebSocket(`ws://127.0.0.1:8443${state.gateway.websocketPath}`);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    let result = Buffer.alloc(0);
    let opened = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(opened ? undefined : new Error('WebSocket did not open')), 1500);
    ws.addEventListener('open', () => {
      opened = true;
      ws.send(vlessRequest(uuid, host, port));
    });
    ws.addEventListener('message', (event) => {
      result = Buffer.concat([result, Buffer.from(event.data)]);
      if (result.includes(Buffer.from('client-exit-test'))) finish();
    });
    ws.addEventListener('close', () => finish(opened ? undefined : new Error('WebSocket closed before opening')));
    ws.addEventListener('error', () => finish(opened ? undefined : new Error('WebSocket failed before opening')));
  });
}

function pass(label) {
  checks += 1;
  console.log(`PASS ${checks}: ${label}`);
}

async function expectExit(uuid, selected, label) {
  const before = witnesses.map((item) => item.hits.length);
  const response = await connectVless(uuid);
  assert.deepEqual(response.subarray(0, 2), Buffer.from([0, 0]), `${label}: VLESS response header`);
  assert.equal(response.subarray(2).toString(), `${selected.marker}client-exit-test`, label);
  witnesses.forEach((item, index) => {
    assert.equal(item.hits.length, before[index] + Number(item === selected), `${label}: ${item.name} hit count`);
    if (item === selected) assert.deepEqual(item.hits.at(-1), { host: '8.8.8.8', port: 443 });
  });
  pass(label);
}

async function expectRejected(uuid, label, host = '8.8.8.8') {
  const before = witnesses.map((item) => item.hits.length);
  const response = await connectVless(uuid, host);
  assert.ok(!response.toString().includes('EXIT:'), `${label}: must not receive any witness payload`);
  assert.deepEqual(witnesses.map((item) => item.hits.length), before, `${label}: no exit received CONNECT`);
  pass(label);
}

try {
  const threeExits = structuredClone(state);
  threeExits.tailscale.extraExits.push({
    id: exitProfileId('test-third-exit'), name: 'third-test-exit', address: '100.64.0.4', authKey: null,
  });
  const originalServer = renderSingBoxConfig(threeExits);
  assert.equal(originalServer.endpoints.length, 3);
  assert.equal(originalServer.inbounds[0].users.length, 6);
  const originalClient = renderSingBoxClientConfig(threeExits, 'alice');
  assert.equal(originalClient.outbounds[0].type, 'selector');
  assert.equal(originalClient.outbounds[0].outbounds.length, 3);
  for (const [label, rendered] of [['server', originalServer], ['client', originalClient]]) {
    const path = join(directory, `${label}-original.json`);
    await writeFile(path, JSON.stringify(rendered), { mode: 0o600 });
    const result = spawnSync(binary, ['check', '-c', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    pass(`Real sing-box accepts the original three-exit ${label} configuration`);
  }
  const defaultExit = await witness('default');
  const extraExit = await witness('additional');
  const config = await startSingBox(state);
  const [alice, bob] = identities;
  await expectExit(alice.defaultUuid, defaultExit, 'Alice selects the default exit');
  await expectExit(bob.extraUuid, extraExit, 'Bob independently selects the additional exit');
  await expectExit(alice.extraUuid, extraExit, 'Alice switches to the additional exit');
  await expectExit(bob.defaultUuid, defaultExit, 'Bob independently switches to the default exit');
  const beforeConcurrent = witnesses.map((item) => item.hits.length);
  const concurrent = await Promise.all([
    connectVless(alice.defaultUuid), connectVless(alice.extraUuid), connectVless(bob.extraUuid),
  ]);
  concurrent.forEach((response, index) => {
    const selected = index === 0 ? defaultExit : extraExit;
    assert.deepEqual(response.subarray(0, 2), Buffer.from([0, 0]));
    assert.equal(response.subarray(2).toString(), `${selected.marker}client-exit-test`);
  });
  assert.deepEqual(witnesses.map((item) => item.hits.length), [beforeConcurrent[0] + 1, beforeConcurrent[1] + 2]);
  pass('Concurrent users and two simultaneous choices by Alice remain independent');

  for (const [index, user] of config.inbounds[1].users.entries()) {
    const before = witnesses.map((item) => item.hits.length);
    await probeSocksConnect({
      proxyPort: state.health.listenPort, username: user.username, password: user.password,
      targetHost: '8.8.4.4', targetPort: 443, timeoutMs: 1500,
    });
    assert.deepEqual(witnesses.map((item) => item.hits.length), before.map((count, position) => count + Number(index === position)));
    assert.deepEqual(witnesses[index].hits.at(-1), { host: '8.8.4.4', port: 443 });
    pass(`The ${witnesses[index].name} health credential probes its own exit`);
  }

  await expectRejected('00000000-0000-4000-8000-000000000099', 'Unknown VLESS UUID is rejected');
  await expectRejected(alice.defaultUuid, 'Default exit blocks loopback destinations', '127.0.0.1');
  await expectRejected(alice.extraUuid, 'Additional exit blocks private destinations', '10.0.0.1');
  await expectRejected(alice.extraUuid, 'Additional exit blocks Tailnet destinations', '100.64.0.1');

  for (const status of ['disabled', 'revoked']) {
    const changed = structuredClone(state);
    changed.users[0].status = status;
    changed.users[0][status === 'disabled' ? 'disabledAt' : 'revokedAt'] = FIXTURE_TIME;
    const updatedConfig = await startSingBox(changed);
    const activeUuids = updatedConfig.inbounds[0].users.map((user) => user.uuid);
    assert.ok(!activeUuids.includes(alice.defaultUuid) && !activeUuids.includes(alice.extraUuid));
    await expectRejected(alice.defaultUuid, `${status}: Alice's original credential is rejected after restart`);
    await expectRejected(alice.extraUuid, `${status}: Alice's derived credential is rejected after restart`);
    await expectExit(bob.extraUuid, extraExit, `${status}: Bob's additional-exit credential still works`);
  }

  await startSingBox(state);
  await extraExit.stop();
  await expectRejected(alice.extraUuid, 'Unavailable additional exit does not fall back to the default exit');
  await expectExit(bob.defaultUuid, defaultExit, 'Default exit still works while the additional exit is unavailable');
  console.log(`Verified ${checks} cases with real sing-box 1.13.21 and local SOCKS witnesses. Tailscale enrollment and Cloudflare were not exercised.`);
} catch (error) {
  if (childOutput) console.error(childOutput);
  throw error;
} finally {
  await stopSingBox();
  await Promise.all(witnesses.map((item) => item.stop()));
  await rm(directory, { recursive: true, force: true });
}
