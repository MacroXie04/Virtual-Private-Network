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

test('bare Cloudflare deployment is pinned, credential-backed, and loopback-only', async () => {
  const [installer, target, tunnel, controller, singBox, subscription, admin] = await Promise.all([
    readProjectFile('deploy/systemd/install.sh'),
    readProjectFile('deploy/systemd/vpn-gateway.target'),
    readProjectFile('deploy/systemd/vpn-gateway-tunnel.service'),
    readProjectFile('deploy/systemd/vpn-gateway-controller.service'),
    readProjectFile('deploy/systemd/vpn-gateway-sing-box.service'),
    readProjectFile('deploy/systemd/vpn-gateway-subscription.service'),
    readProjectFile('deploy/systemd/vpn-gateway-admin.service'),
  ]);

  assert.match(installer, /readonly REQUIRED_CLOUDFLARED_VERSION=2026\.8\.3/u);
  assert.match(installer, /readonly MIN_SYSTEMD_VERSION=247/u);
  assert.match(installer, /CLOUDFLARED_BIN.*== \/usr\/bin\/cloudflared/u);
  assert.match(installer, /cloudflared exactly \$REQUIRED_CLOUDFLARED_VERSION is required/u);
  assert.match(installer, /ensure_group vpn-tunnel 11003/u);
  assert.match(installer, /ensure_user vpn-tunnel 11003 11003/u);
  assert.match(installer, /validate_service_namespace vpn-tunnel/u);
  assert.match(installer, /constants\.O_RDONLY \| constants\.O_NOFOLLOW/u);
  assert.match(installer, /!\[0o400, 0o600\]\.includes\(mode\)/u);
  assert.match(installer, /decoded token has an unsupported shape/u);
  assert.match(installer, /write_environment_value ADMIN_PUBLIC_HOSTNAME "\$ADMIN_PUBLIC_HOSTNAME"/u);
  assert.doesNotMatch(installer, /ADMIN_ALLOWED_HOSTS|ADMIN_ALLOWED_ORIGINS/u);
  assert.match(installer, /UPGRADE_HAD_UNIT_TUNNEL/u);
  assert.match(installer, /if path_is_present "\$metadata_root\/unit-tunnel"/u);
  assert.match(installer, /MIGRATE_REALITY must be exactly 1/u);
  assert.match(installer, /MIGRATE_LEGACY must be exactly 1/u);
  assert.match(installer, /"MIGRATION_MARKER_DIR=\$MIGRATION_MARKER"/u);
  assert.match(installer, /"TS_API_KEY_FILE=\$MIGRATION_API_KEY_FILE"/u);
  assert.match(installer, /run_legacy_bootstrap 1 migrated,recovered/u);
  assert.match(
    installer,
    /if \[\[ "\$LEGACY_SOURCE_STATE" == "\$STATE_ROOT\/tailscale" \]\]; then\s+die "The legacy Tailscale state directory already equals the migration destination/u,
  );
  const inPlaceStateReject = installer.indexOf(
    'The legacy Tailscale state directory already equals the migration destination',
  );
  const legacyApproval = installer.indexOf('case "${MIGRATE_LEGACY:-}" in');
  const legacyStateCopy = installer.indexOf('cp -a -- "$LEGACY_SOURCE_STATE/."');
  assert.ok(
    inPlaceStateReject > 0
      && legacyApproval > inPlaceStateReject
      && legacyStateCopy > legacyApproval,
    'an in-place legacy identity must be rejected before approval or state-copy mutations',
  );
  assert.match(installer, /await assertLegacyV1MigrationLineage\(\{/u);
  const lineageCheck = installer.indexOf('await assertLegacyV1MigrationLineage({');
  const statePublishedMarker = installer.indexOf(
    'install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER/state-published"',
    lineageCheck,
  );
  assert.ok(
    lineageCheck > 0 && statePublishedMarker > lineageCheck,
    'v1 migration lineage must be authenticated and persisted before services may scrub its credentials',
  );
  const migrationStart = installer.indexOf('Starting the migration candidate with boot enablement held until commit');
  const migrationCommit = installer.indexOf('mv -- "$MIGRATION_MARKER/committed" "$MIGRATION_COMMITTED_MARKER"');
  const migrationEnable = installer.indexOf('systemctl enable vpn-gateway.target', migrationCommit);
  assert.ok(
    migrationStart > 0 && migrationCommit > migrationStart && migrationEnable > migrationCommit,
    'legacy migration must remain boot-disabled until its durable commit is published',
  );
  assert.match(installer, /stop_unit_if_active_strict vpn-gateway-tunnel\.service yes\s+hold_migration_target_disabled/u);
  assert.match(installer, /TCP 443 is listening on the origin host/u);
  assert.match(installer, /for \(const port of \[8443, 8080, 8081, 20241\]\)/u);
  assert.match(installer, /ordinary HTTP request on the canonical WebSocket path was not rejected/u);
  assert.match(installer, /tunnel --metrics 127\.0\.0\.1:20241 ready/u);

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

test('bare installer keeps valid shell syntax', async () => {
  await execFile('bash', ['-n', path.join(projectRoot, 'deploy/systemd/install.sh')], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
});

test('deployment guide links the required official Cloudflare guidance', async () => {
  const readme = await readProjectFile('docs/deployment.md');
  assert.match(readme, /developers\.cloudflare\.com\/cloudflare-one\/networks\/connectors\/cloudflare-tunnel\/get-started\/create-remote-tunnel\//u);
  assert.match(readme, /developers\.cloudflare\.com\/network\/websockets\//u);
  assert.match(readme, /developers\.cloudflare\.com\/cloudflare-one\/access-controls\/applications\/http-apps\/self-hosted-public-app\//u);
  assert.match(readme, /cloudflare\.com\/service-specific-terms-zero-trust-services\//u);
});
