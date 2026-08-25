import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  fromEnv,
  buildMixed,
  buildSingboxConfig,
  buildClashConfig,
  buildShareLinks,
} from './generate.js';
import { buildPage } from './page.js';
import { parseTsOutbound, updateTsOutbound, fetchExitNodes } from './tailscale.js';

const token = process.env.SUB_TOKEN;
if (!token) {
  console.error('Missing environment variable SUB_TOKEN');
  process.exit(1);
}

const cfg = fromEnv();
const listenPort = Number(process.env.LISTEN_PORT ?? 8080);
const singboxConfigPath = process.env.SINGBOX_CONFIG ?? '/etc/sing-box/config.json';
const tsCtlPath = process.env.TS_CTL ?? '/opt/vpn-sub/ts-ctl.sh';
const tsApiKey = process.env.TS_API_KEY ?? '';

// Runs as root inside the container (no sudo); on bare-metal systemd, ts-ctl.sh is allowed via sudoers
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const ctlCmd = (args) => (isRoot ? [tsCtlPath, args] : ['sudo', [tsCtlPath, ...args]]);

const handlers = {
  mixed: {
    contentType: 'text/plain; charset=utf-8',
    body: () => buildMixed(cfg),
  },
  singbox: {
    contentType: 'application/json; charset=utf-8',
    body: () => JSON.stringify(buildSingboxConfig(cfg), null, 2),
  },
  clash: {
    contentType: 'text/yaml; charset=utf-8',
    body: () => buildClashConfig(cfg),
  },
  links: {
    contentType: 'text/plain; charset=utf-8',
    body: () => buildShareLinks(cfg).join('\n') + '\n',
  },
  page: {
    contentType: 'text/html; charset=utf-8',
    body: (host, tsState) => buildPage(cfg, `http://${host}/${token}`, tsState),
  },
};

function sniffFormat(req) {
  const accept = String(req.headers['accept'] ?? '').toLowerCase();
  if (accept.includes('text/html')) return 'page';
  const ua = String(req.headers['user-agent'] ?? '').toLowerCase();
  if (ua.includes('sing-box') || ua.includes('singbox')) return 'singbox';
  if (ua.includes('clash')) return 'clash';
  return 'mixed';
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch {
    return '';
  }
}

async function collectTsState() {
  const state = {
    service: isRoot
      ? (run('pgrep', ['-x', 'sing-box']) ? 'active' : 'stopped')
      : run('systemctl', ['is-active', 'sing-box']) || 'unknown',
  };
  try {
    Object.assign(state, parseTsOutbound(JSON.parse(fs.readFileSync(singboxConfigPath, 'utf8'))));
  } catch (err) {
    state.error = `Failed to read sing-box config: ${err.message}`;
  }
  state.exitNodes = tsApiKey ? await fetchExitNodes(tsApiKey) : [];
  state.logs = run(...ctlCmd(['logs']));
  return state;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Update the tailscale outbound and restart sing-box; returns null or an error message
function applyTsConfig({ authKey, exitNode }) {
  let next;
  try {
    const current = JSON.parse(fs.readFileSync(singboxConfigPath, 'utf8'));
    next = updateTsOutbound(current, { authKey, exitNode });
  } catch (err) {
    return err.message;
  }
  const tmp = `/tmp/singbox-config-${process.pid}-${Date.now()}.json`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    const [cmd, args] = ctlCmd(['apply', tmp]);
    execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000 });
    return null;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore cleanup failure */ }
    const detail = String(err.stderr || err.message || err).trim().split('\n').pop();
    return detail || 'Failed to apply config';
  }
}

const server = http.createServer(async (req, res) => {
  const notFound = () => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  };

  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 2 || parts[0] !== token) return notFound();

  const redirectToPage = (flash) => {
    res.writeHead(303, { location: `/${token}${flash ? `?ts=${encodeURIComponent(flash)}` : ''}` });
    res.end();
  };

  if (req.method === 'POST') {
    if (parts[1] !== 'tailscale') return notFound();
    try {
      const form = new URLSearchParams(await readBody(req));
      const err = applyTsConfig({
        authKey: form.get('authKey') ?? '',
        exitNode: form.get('exitNode') ?? '',
      });
      redirectToPage(err ? `err:${err}` : 'ok');
    } catch (err) {
      redirectToPage(`err:${err.message}`);
    }
    return;
  }

  if (req.method !== 'GET') return notFound();

  const format = parts[1] ?? sniffFormat(req);
  const handler = handlers[format];
  if (!handler) return notFound();

  const tsState = format === 'page' ? await collectTsState() : undefined;
  if (format === 'page') tsState.flash = url.searchParams.get('ts') ?? '';

  res.writeHead(200, { 'content-type': handler.contentType });
  res.end(handler.body(req.headers.host, tsState));
});

server.listen(listenPort, () => {
  console.log(`subscription server listening on :${listenPort}`);
});
