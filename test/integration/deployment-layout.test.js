import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const readProjectFile = (relativePath) => readFile(path.join(projectRoot, relativePath), 'utf8');

test('container pins supported runtimes and Compose exposes origins only through cloudflared', async () => {
  const [
    dockerfile,
    compose,
    entrypoint,
    tunnelDockerfile,
    tunnelGuard,
    composeLauncher,
    dockerignore,
    exampleEnvironment,
    singBoxModule,
    cloudflaredModule,
  ] = await Promise.all([
    readProjectFile('deploy/docker/Dockerfile'),
    readProjectFile('docker-compose.yml'),
    readProjectFile('deploy/docker/entrypoint.sh'),
    readProjectFile('deploy/docker/cloudflared.Dockerfile'),
    readProjectFile('deploy/docker/cloudflared-guard.go'),
    readProjectFile('deploy/docker/compose-up.sh'),
    readProjectFile('.dockerignore'),
    readProjectFile('.env.example'),
    readProjectFile('deploy/docker/sing-box/go.mod'),
    readProjectFile('deploy/docker/cloudflared/go.mod'),
  ]);

  assert.match(dockerfile, /FROM node:24\.20\.0-alpine3\.24@sha256:[0-9a-f]{64}/u);
  assert.match(singBoxModule, /^\s*github\.com\/sagernet\/sing-box v1\.13\.21$/mu);
  assert.match(dockerfile, /go build -mod=readonly/u);
  assert.match(dockerfile, /github\.com\/sagernet\/sing-box\/cmd\/sing-box/u);
  assert.match(dockerfile, /libcrypto3=3\.5\.8-r0 libssl3=3\.5\.8-r0/u);
  assert.match(dockerfile, /ADD --checksum=sha256:9f58bff01604cb1b14008fef14dceb14d836a49225e45c6c2e37de3be3e707f0/u);
  assert.match(dockerfile, /npm install --global --offline --ignore-scripts/u);
  assert.match(dockerfile, /with_tailscale/u);
  assert.doesNotMatch(dockerfile, /^EXPOSE\b/mu);
  assert.doesNotMatch(compose, /^\s+ports:\s*$/mu);
  assert.doesNotMatch(compose, /^\s+expose:\s*$/mu);
  assert.doesNotMatch(compose, /network_mode:\s*["']?host/u);
  assert.match(compose, /NODE_HOST: 127\.0\.0\.1/u);
  assert.match(compose, /SUB_HOST: 127\.0\.0\.1/u);
  assert.match(compose, /ADMIN_HOST: 127\.0\.0\.1/u);
  assert.match(compose, /MIGRATE_REALITY: "\$\{MIGRATE_REALITY:-\}"/u);
  assert.doesNotMatch(compose, /ADMIN_ALLOWED_HOSTS|ADMIN_ALLOWED_ORIGINS/u);
  assert.match(compose, /network_mode: "service:vpn-gateway"/u);
  assert.match(compose, /condition: service_started/u);
  assert.match(compose, /source: \$\{CLOUDFLARE_TUNNEL_TOKEN_FILE:\?Set CLOUDFLARE_TUNNEL_TOKEN_FILE in \.env\}/u);
  assert.match(compose, /target: \/run\/secrets\/cloudflare-tunnel-token/u);
  assert.match(compose, /test: \["CMD", "\/usr\/local\/bin\/cloudflared-guard", "ready"\]/u);
  assert.match(compose, /- \/tmp:size=4m,mode=1777,nosuid,nodev,noexec/u);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/u);
  assert.match(compose, /cap_add:\s*\n\s*- SETGID\s*\n\s*- SETPCAP\s*\n\s*- SETUID/u);
  assert.match(compose, /read_only: true/u);
  assert.doesNotMatch(compose, /(?:^|\s)(?:TUNNEL_TOKEN|--token)(?:\s|:|=)/u);
  assert.match(
    tunnelDockerfile,
    /FROM gcr\.io\/distroless\/base-debian13:nonroot@sha256:d199d20fb09c898d8822ae5cbd5cf3c6d424e9b5e1fc2eb9a719a7752cd9d861/u,
  );
  assert.match(tunnelDockerfile, /ADD --checksum=sha256:908aab97646925b8df7cd832c3aed96113cff070d3b41f665ffa55a86f1b04b5/u);
  assert.match(tunnelDockerfile, /go build -mod=readonly/u);
  assert.match(tunnelDockerfile, /-X main\.Version=2026\.8\.3/u);
  assert.match(cloudflaredModule, /^module github\.com\/cloudflare\/cloudflared$/mu);
  assert.match(tunnelDockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/cloudflared-guard"\]/u);
  assert.match(tunnelGuard, /tokenFD\s+= 9/u);
  assert.match(tunnelGuard, /syscall\.O_NOFOLLOW/u);
  assert.match(tunnelGuard, /stat\.Uid == 0/u);
  assert.match(tunnelGuard, /permissions == 0o400 \|\| permissions == 0o600/u);
  assert.match(tunnelGuard, /syscall\.Setresuid\(serviceID, serviceID, serviceID\)/u);
  assert.match(tunnelGuard, /prCapBsetDrop\s+= 24/u);
  assert.match(tunnelGuard, /"CapBnd": false/u);
  assert.match(tunnelGuard, /assertDroppedPrivileges/u);
  assert.match(tunnelGuard, /"--token-file", "\/proc\/self\/fd\/9"/u);
  assert.match(tunnelGuard, /"--metrics", "127\.0\.0\.1:2000"/u);
  assert.match(tunnelGuard, /"--loglevel", "fatal"/u);
  assert.doesNotMatch(tunnelGuard, /"--loglevel", "(?:debug|info|warn|error)"/u);
  assert.match(composeLauncher, /canonical_token_file="\$\(readlink -f -- "\$token_file"/u);
  assert.match(composeLauncher, /PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/u);
  assert.match(composeLauncher, /"\$\(id -u\)" -eq 0/u);
  assert.match(composeLauncher, /"\$canonical_token_file" = "\$token_file"/u);
  assert.match(composeLauncher, /while :; do[\s\S]*every Tunnel token parent must be owned by root/u);
  assert.match(composeLauncher, /0\$parent_mode & 022/u);
  assert.match(composeLauncher, /stat -c '%u:%a:%h:%s'/u);
  assert.match(composeLauncher, /"\$token_owner" = 0/u);
  assert.match(composeLauncher, /"\$token_mode" = 400.*"\$token_mode" = 600/su);
  assert.match(composeLauncher, /"\$token_links" = 1/u);
  assert.match(composeLauncher, /"\$token_size" -le 4096/u);
  assert.match(composeLauncher, /exec docker compose --project-directory/u);
  assert.doesNotMatch(composeLauncher, /(?:cat|head|tail)\s+.*token/u);
  assert.match(dockerignore, /!deploy\/docker\/cloudflared\.Dockerfile/u);
  assert.match(dockerignore, /!deploy\/docker\/cloudflared-guard\.go/u);
  assert.match(exampleEnvironment, /^CLOUDFLARE_TUNNEL_TOKEN_FILE=\/absolute\/path\/to\/cloudflare-tunnel-token$/mu);
  assert.match(exampleEnvironment, /^MIGRATE_REALITY=$/mu);
  assert.doesNotMatch(exampleEnvironment, /(?:^|\n)TUNNEL_TOKEN=/u);
  assert.match(entrypoint, /canonical_revision_name/u);
  assert.match(entrypoint, /\$\{#canonical_revision_name\}" -eq 33/u);
  assert.match(entrypoint, /\^\[0-9\]\{16\}-\[0-9a-f\]\{16\}\$/u);
  assert.match(entrypoint, /bootstrap_credentials_required=no/u);
  assert.match(entrypoint, /Container listeners must use the fixed loopback-only Cloudflare Tunnel origins/u);
});

test('Docker Compose renders with deterministic non-secret fixtures', async (t) => {
  try {
    await execFile('docker', ['compose', 'version'], { timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch {
    t.skip('Docker Compose is unavailable in this test environment');
    return;
  }

  await execFile('docker', ['compose', '-f', 'docker-compose.yml', 'config', '--quiet'], {
    cwd: projectRoot,
    timeout: 20_000,
    maxBuffer: 256 * 1024,
    env: {
      ...process.env,
      TS_AUTH_KEY_FILE: '/dev/null',
      TS_API_KEY_FILE: '',
      CLOUDFLARE_TUNNEL_TOKEN_FILE: '/dev/null',
      EXIT_NODE: '100.64.0.10',
      VPN_PUBLIC_HOSTNAME: 'vpn.example.com',
      SUBSCRIPTION_PUBLIC_BASE_URL: 'https://sub.example.com',
      ADMIN_PUBLIC_HOSTNAME: 'admin.example.com',
      EGRESS_HEALTH_HOST: 'health.example.com',
      WS_PATH: '',
      NODE_NAME: 'vpn-test',
      MIGRATE_LEGACY: '',
      MIGRATE_REALITY: '',
    },
  });
});
