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
  assertInstallerMatches(/MIGRATE_REALITY must be exactly 1/u);
  assertInstallerMatches(/MIGRATE_LEGACY must be exactly 1/u);
  assertInstallerMatches(/"MIGRATION_MARKER_DIR=\$MIGRATION_MARKER"/u);
  assertInstallerMatches(/"TS_API_KEY_FILE=\$MIGRATION_API_KEY_FILE"/u);
  assertInstallerMatches(/run_legacy_bootstrap 1 migrated,recovered/u);
  assertInstallerMatches(
    /if \[\[ "\$LEGACY_SOURCE_STATE" == "\$STATE_ROOT\/tailscale" \]\]; then\s+die "The legacy Tailscale state directory already equals the migration destination/u,
  );
  const inPlaceStateReject = installerPosition(
    'The legacy Tailscale state directory already equals the migration destination',
  );
  const legacyApproval = installerPosition('case "${MIGRATE_LEGACY:-}" in');
  const legacyStateCopy = installerPosition('cp -a -- "$LEGACY_SOURCE_STATE/."');
  assert.ok(
    inPlaceStateReject > 0
      && legacyApproval > inPlaceStateReject
      && legacyStateCopy > legacyApproval,
    'an in-place legacy identity must be rejected before approval or state-copy mutations',
  );
  assertInstallerMatches(/await assertLegacyV1MigrationLineage\(\{/u);
  const lineageCheck = installerPosition('await assertLegacyV1MigrationLineage({');
  const statePublishedMarker = installerPosition(
    'install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER/state-published"',
    lineageCheck,
  );
  assert.ok(
    lineageCheck > 0 && statePublishedMarker > lineageCheck,
    'v1 migration lineage must be authenticated and persisted before services may scrub its credentials',
  );
  const migrationStart = installerPosition('Starting the migration candidate with boot enablement held until commit');
  const migrationCommit = installerPosition('mv -- "$MIGRATION_MARKER/committed" "$MIGRATION_COMMITTED_MARKER"');
  const migrationEnable = installerPosition('systemctl enable vpn-gateway.target', migrationCommit);
  assert.ok(
    migrationStart > 0 && migrationCommit > migrationStart && migrationEnable > migrationCommit,
    'legacy migration must remain boot-disabled until its durable commit is published',
  );
  assertInstallerMatches(/stop_unit_if_active_strict vpn-gateway-tunnel\.service yes\s+hold_migration_target_disabled/u);
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
