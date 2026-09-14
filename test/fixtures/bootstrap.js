import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';

export async function temporary(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vpn-bootstrap-v3-'));
  try { await run(parent); } finally { await rm(parent, { recursive: true, force: true }); }
}

export async function privateFile(filePath, value) {
  await writeFile(filePath, `${value}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

export function environment(parent) {
  const dataDir = path.join(parent, 'data');
  return {
    DATA_DIR: dataDir,
    SINGBOX_CONFIG: path.join(dataDir, 'runtime', 'sing-box.json'),
    SINGBOX_BIN: '/usr/bin/sing-box',
    SINGBOX_STATE_DIR: path.join(dataDir, 'tailscale'),
    HEALTH_PORT: '19080',
    EXIT_NODE: '100.64.0.10',
    TS_HOSTNAME: 'vpn-gateway',
    VPN_PUBLIC_HOSTNAME: 'vpn.example.com',
    SUBSCRIPTION_PUBLIC_BASE_URL: 'https://sub.example.com',
    ADMIN_PUBLIC_HOSTNAME: 'admin.example.com',
    EGRESS_HEALTH_HOST: 'health.example.net',
    TS_AUTH_KEY_FILE: path.join(parent, 'tailscale-auth'),
    TS_API_KEY_FILE: path.join(parent, 'tailscale-api'),
  };
}
