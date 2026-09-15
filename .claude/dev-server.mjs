// Local development server for the administration site.
//
// Runs the real controller, control socket, administration site and
// subscription worker as they run in production, but replaces the sing-box
// data plane with a stub: this machine has no sing-box binary, no Tailscale
// enrollment key and no routed exit. Every restart and readiness probe
// therefore succeeds, so the UI and control plane can be exercised locally.
// Nothing here is used by the Docker or systemd deployments.
//
// Environment: DEV_ROOT (state directory, default under the OS temp dir),
// DEV_ADMIN_PASSWORD (default local-dev-password), DEV_ACCOUNT_PASSWORD (the
// seeded "Demo User" portal password, default local-dev-account), ADMIN_PORT
// (default 18081), SUB_PORT (default 18080). Both listeners bind 127.0.0.1 only.
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RevisionRepository } from '../src/state/repository.js';
import { GatewayController } from '../src/control/authority/controller.js';
import { UsageTracker } from '../src/control/authority/usage.js';
import { createAdminScryptRecord, hashSubscriptionToken } from '../src/core/identity/credentials.js';
import { createControllerApplication } from '../src/control/app/application.js';

const ADMIN_PASSWORD = process.env.DEV_ADMIN_PASSWORD ?? 'local-dev-password';
const ACCOUNT_PASSWORD = process.env.DEV_ACCOUNT_PASSWORD ?? 'local-dev-account';
const DEMO_TOKEN = 'D'.repeat(43);
const ADMIN_PORT = process.env.ADMIN_PORT ?? '18081';
const SUB_PORT = process.env.SUB_PORT ?? '18080';
// macOS limits Unix socket paths to 104 bytes, so the state stays in a short
// temp path rather than a project-relative one.
const root = process.env.DEV_ROOT ?? path.join(os.tmpdir(), 'vpn-gateway-dev');
const dataDir = path.join(root, 'data');
const runDir = path.join(root, 'run');
const socketPath = path.join(runDir, 'controller.sock');
const uid = process.getuid();
const gid = process.getgid();

const log = (line) => process.stdout.write(`[dev-server] ${line}\n`);

class StubSingBoxRuntime {
  constructor() { this.health = null; this.running = false; }
  async start() { this.running = true; log('stub sing-box: start'); }
  async stop() { this.running = false; log('stub sing-box: stop'); }
  async restart() { await this.stop(); await this.start(); }
  async probe() {
    log(`stub sing-box: readiness probe ok (${this.health?.profiles?.length ?? 1} exit profile(s))`);
    return true;
  }
  isRunning() { return this.running; }
}

// Fresh state on every start: the development instance never keeps users
// beyond the seeded demo account below.
// Only the two directories this script owns are cleared, never an arbitrary DEV_ROOT.
await rm(dataDir, { recursive: true, force: true });
await rm(runDir, { recursive: true, force: true });
await mkdir(runDir, { recursive: true, mode: 0o700 });

const repository = new RevisionRepository(dataDir);
const now = new Date().toISOString();
const revision = await repository.initialize({
  schemaVersion: 3,
  revision: 1,
  createdAt: now,
  updatedAt: now,
  gateway: {
    vpnPublicHostname: 'vpn.example.com',
    subscriptionPublicBaseUrl: 'https://admin.example.com',
    adminPublicHostname: 'admin.example.com',
    websocketPath: `/${'A'.repeat(43)}`,
  },
  tailscale: {
    hostname: 'local-dev-gateway',
    stateDirectory: path.join(dataDir, 'tailscale'),
    authKey: null,
    apiKey: null,
    exitNode: '100.64.0.10',
  },
  health: {
    listenPort: 19080,
    username: 'vpn-health',
    password: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
    target: { host: 'health.example.net', port: 443 },
  },
  admin: { scrypt: await createAdminScryptRecord(ADMIN_PASSWORD) },
  users: [{
    id: 'demo-user',
    displayName: 'Demo User',
    uuid: '0d3d0d3d-0d3d-4d3d-8d3d-0d3d0d3d0d3d',
    tokenHash: hashSubscriptionToken(DEMO_TOKEN),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    disabledAt: null,
    revokedAt: null,
    password: await createAdminScryptRecord(ACCOUNT_PASSWORD),
  }],
}, { operation: 'bootstrap' });
log(`initialized state revision ${revision.revision} in ${dataDir}`);

const runtime = new StubSingBoxRuntime();
// The stub has no stats API, so synthesize growing per-user counters: every
// sample adds traffic for each non-revoked user so the UI shows usage.
let tick = 0;
const usage = new UsageTracker({
  path: path.join(dataDir, 'usage.json'),
  query: async () => {
    tick += 1;
    const state = await repository.readCurrentState();
    return (state?.users ?? []).filter((user) => user.status !== 'revoked').flatMap((user, index) => [
      { name: `user>>>${user.id}>>>traffic>>>uplink`, value: tick * 125_000 * (index + 1) },
      { name: `user>>>${user.id}>>>traffic>>>downlink`, value: tick * 2_400_000 * (index + 1) },
    ]);
  },
});
const controller = new GatewayController({
  repository,
  runtime,
  dataDir,
  usage,
  validateConfig: async (configPath) => log(`config check skipped for ${path.basename(configPath)} (no sing-box binary)`),
});

const app = await createControllerApplication({
  env: {
    DATA_DIR: dataDir,
    CONTROLLER_SOCKET: socketPath,
    SINGBOX_CONFIG: path.join(dataDir, 'runtime', 'sing-box.json'),
    SUPERVISE: '1',
    SINGBOX_GID: String(gid),
    SUB_UID: String(uid), SUB_GID: String(gid),
    ADMIN_UID: String(uid), ADMIN_GID: String(gid),
    ADMIN_PUBLIC_HOSTNAME: 'admin.example.com',
    LOCAL_HTTP_ORIGIN: `http://127.0.0.1:${ADMIN_PORT}`,
    SUB_HOST: '127.0.0.1', SUB_PORT,
    ADMIN_HOST: '127.0.0.1', ADMIN_PORT,
  },
  repository,
  runtime,
  controller,
  usage,
  socketUid: null,
});

let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  log('shutting down');
  void app.close(0).finally(() => { process.exitCode = app.exitCode; });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.start();
log(`control socket: ${socketPath}`);
log(`administration site: http://127.0.0.1:${ADMIN_PORT}/login`);
log(`administrator secret: ${process.env.DEV_ADMIN_PASSWORD === undefined ? ADMIN_PASSWORD : 'taken from DEV_ADMIN_PASSWORD'}`);
log(`user portal: http://127.0.0.1:${ADMIN_PORT}/account/login`);
log(`demo account: sign in as "Demo User" with password ${process.env.DEV_ACCOUNT_PASSWORD === undefined ? ACCOUNT_PASSWORD : 'taken from DEV_ACCOUNT_PASSWORD'}`);
log(`demo subscription: http://127.0.0.1:${ADMIN_PORT}/s/${DEMO_TOKEN}`);
