import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { assertInstallerMatches, assertInstallerExcludes, installerPosition, installerModuleNames } from '../fixtures/installer.js';

const execFile = promisify(execFileCallback);
const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const readProjectFile = (relativePath) => readFile(path.join(projectRoot, relativePath), 'utf8');

test('bare Cloudflare deployment is pinned, credential-backed, and loopback-only', async () => {
  const [target, tunnel, controller, singBox, subscription, admin] = await Promise.all([
    readProjectFile('deploy/systemd/vpn-gateway.target'),
    readProjectFile('deploy/systemd/vpn-gateway-tunnel.service'),
    readProjectFile('deploy/systemd/vpn-gateway-controller.service'),
    readProjectFile('deploy/systemd/vpn-gateway-sing-box.service'),
    readProjectFile('deploy/systemd/vpn-gateway-subscription.service'),
    readProjectFile('deploy/systemd/vpn-gateway-admin.service'),
  ]);

  assertInstallerMatches(/readonly REQUIRED_CLOUDFLARED_VERSION=2026\.8\.3/u);
  assertInstallerMatches(/readonly MIN_SYSTEMD_VERSION=247/u);
  assertInstallerMatches(/CLOUDFLARED_BIN.*== \/usr\/bin\/cloudflared/u);
  assertInstallerMatches(/cloudflared exactly \$REQUIRED_CLOUDFLARED_VERSION is required/u);
  assertInstallerMatches(/ensure_group vpn-tunnel 11003/u);
  assertInstallerMatches(/ensure_user vpn-tunnel 11003 11003/u);
  assertInstallerMatches(/validate_service_namespace vpn-tunnel/u);
  assertInstallerMatches(/constants\.O_RDONLY \| constants\.O_NOFOLLOW/u);
  assertInstallerMatches(/!\[0o400, 0o600\]\.includes\(mode\)/u);
  assertInstallerMatches(/decoded token has an unsupported shape/u);
  assertInstallerMatches(/write_environment_value ADMIN_PUBLIC_HOSTNAME "\$ADMIN_PUBLIC_HOSTNAME"/u);
  assertInstallerExcludes(/ADMIN_ALLOWED_HOSTS|ADMIN_ALLOWED_ORIGINS/u);
  assertInstallerMatches(/UPGRADE_HAD_UNIT_TUNNEL/u);
  assertInstallerMatches(/if path_is_present "\$metadata_root\/unit-tunnel"/u);
  assertInstallerExcludes(/MIGRATE_|MIGRATION_|run_legacy_bootstrap|assertLegacyV1MigrationLineage/u);
  assertInstallerMatches(/reject_retired_deployment/u);
  assertInstallerMatches(/await assertSupportedDataDirectory/u);
  assertInstallerMatches(/runtimeGid: 11000/u);
  assertInstallerMatches(/subscriptionGid: Number\(process\.env\.SUBSCRIPTION_GID\)/u);
  assertInstallerExcludes(/systemctl (?:stop|disable(?: --now)?) (?:vpn-sub|sing-box)\.service/u);
  assert.ok(
    installerPosition('reject_retired_deployment\n') < installerPosition('ensure_group vpn-runtime 11000'),
    'unsupported existing deployments are rejected before service identity creation',
  );
  assertInstallerMatches(/TCP 443 is listening on the origin host/u);
  assertInstallerMatches(/for \(const port of \[8443, 8080, 8081, 20241\]\)/u);
  assertInstallerMatches(/ordinary HTTP request on the canonical WebSocket path was not rejected/u);
  assertInstallerMatches(/tunnel --metrics 127\.0\.0\.1:20241 ready/u);

  assert.match(target, /^Requires=.*vpn-gateway-tunnel\.service$/mu);
  assert.match(target, /^WantedBy=multi-user\.target$/mu);
  assert.match(tunnel, /^Type=notify$/mu);
  assert.match(tunnel, /^User=vpn-tunnel$/mu);
  assert.match(tunnel, /^Group=vpn-tunnel$/mu);
  assert.match(
    tunnel,
    /^LoadCredential=cloudflare-tunnel-token:\/etc\/vpn-gateway\/secrets\/cloudflare-tunnel-token$/mu,
  );
  assert.match(tunnel, /^ExecStartPre=\/usr\/bin\/test -s %d\/cloudflare-tunnel-token$/mu);
  assert.match(
    tunnel,
    /^ExecStart=\/usr\/bin\/cloudflared --no-autoupdate tunnel --metrics 127\.0\.0\.1:20241 --loglevel fatal --grace-period 30s run --token-file %d\/cloudflare-tunnel-token$/mu,
  );
  assert.match(tunnel, /^ExecStartPost=\/usr\/bin\/cloudflared tunnel --metrics 127\.0\.0\.1:20241 ready$/mu);
  assert.match(tunnel, /^ProtectSystem=strict$/mu);
  assert.match(tunnel, /^CapabilityBoundingSet=$/mu);
  assert.match(tunnel, /^AmbientCapabilities=$/mu);
  assert.doesNotMatch(tunnel, /^\[Install\]$/mu);

  assert.match(controller, /^Environment=NODE_PORT=8443$/mu);
  assert.doesNotMatch(controller, /^Environment=NODE_PORT=443$/mu);
  assert.match(
    controller,
    /^ExecStartPost=\/usr\/bin\/systemctl --no-block start vpn-gateway-subscription\.service vpn-gateway-admin\.service vpn-gateway-tunnel\.service$/mu,
  );
  assert.match(subscription, /SUB_HOST=127\.0\.0\.1 SUB_PORT=8080/u);
  assert.match(admin, /ADMIN_HOST=127\.0\.0\.1 ADMIN_PORT=8081/u);
  assert.match(singBox, /^CapabilityBoundingSet=$/mu);
  assert.match(singBox, /^AmbientCapabilities=$/mu);
});

test('bare installer and every loaded module keep valid shell syntax', async () => {
  await Promise.all(['install.sh', ...installerModuleNames.map((name) => `installer/${name}`)].map((script) => (
    execFile('bash', ['-n', path.join(projectRoot, 'deploy/systemd', script)], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    })
  )));
});

test('deployment guide links the required official Cloudflare guidance', async () => {
  const readme = await readProjectFile('docs/deployment.md');
  assert.match(readme, /developers\.cloudflare\.com\/cloudflare-one\/networks\/connectors\/cloudflare-tunnel\/get-started\/create-remote-tunnel\//u);
  assert.match(readme, /developers\.cloudflare\.com\/network\/websockets\//u);
  assert.match(readme, /developers\.cloudflare\.com\/cloudflare-one\/access-controls\/applications\/http-apps\/self-hosted-public-app\//u);
  assert.match(readme, /cloudflare\.com\/service-specific-terms-zero-trust-services\//u);
});
