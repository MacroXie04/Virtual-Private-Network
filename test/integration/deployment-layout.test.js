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

test('supported Node policy and bare-metal ES-module layout stay aligned', async () => {
  const [
    packageText,
    installer,
    controllerUnit,
    singBoxUnit,
    adminUnit,
    subscriptionUnit,
    repository,
    controller,
  ] = await Promise.all([
    readProjectFile('package.json'),
    readProjectFile('deploy/systemd/install.sh'),
    readProjectFile('deploy/systemd/vpn-gateway-controller.service'),
    readProjectFile('deploy/systemd/vpn-gateway-sing-box.service'),
    readProjectFile('deploy/systemd/vpn-gateway-admin.service'),
    readProjectFile('deploy/systemd/vpn-gateway-subscription.service'),
    readProjectFile('src/state/repository.js'),
    readProjectFile('src/control/controller.js'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.engines.node, '>=24.20.0 <25');
  assert.match(installer, /readonly MIN_NODE_VERSION=24\.20\.0/u);
  assert.match(installer, /NODE_MAJOR != 24 \|\| NODE_MINOR < 20/u);
  assert.match(installer, /install -o root -g root -m 0644 "\$REPO_DIR\/package\.json" "\$INSTALL_ROOT\/package\.json"/u);
  assert.match(installer, /passwd_records="\$\(getent passwd\)"/u);
  assert.match(installer, /group_records="\$\(getent group\)"/u);
  assert.match(installer, /Service gid \$expected_gid is the primary gid of passwd principal/u);
  assert.match(installer, /Service group \$service_name contains unauthorized member/u);
  assert.match(installer, /passwd -S "\$service_name"/u);
  assert.match(installer, /\/usr\/sbin\/nologin\|\/sbin\/nologin\|\/usr\/bin\/false\|\/bin\/false/u);
  assert.match(installer, /UPGRADE_ROLLBACK_JOURNAL="\$STATE_ROOT\/\.upgrade-rollback-in-progress"/u);
  assert.match(installer, /UPGRADE_RESTART_JOURNAL="\$STATE_ROOT\/\.upgrade-restart-in-progress"/u);
  assert.match(installer, /INSTALLER_LOCK=\/run\/vpn-gateway-installer\.lock/u);
  assert.match(installer, /flock -n "\$INSTALLER_LOCK_FD"/u);
  assert.match(installer, /\(8#\$run_mode & 8#022\) != 0/u);
  assert.match(installer, /begin_upgrade_rollback_transaction\s*\nfi\s*\n\s*install -d/u);
  assert.match(installer, /sync -f "\$UPGRADE_ROLLBACK_JOURNAL"/u);
  assert.match(installer, /\.revisions-restore-build\.\$restore_token\.XXXXXXXXXX/u);
  assert.match(installer, /reconcile_repository_revision_crash_artifacts "\$STATE_ROOT\/revisions"/u);
  assert.match(installer, /normalize_upgrade_repository_ownership/u);
  assert.match(installer, /mark_upgrade_rollback_restored/u);
  assert.match(installer, /constants\.O_RDONLY \| constants\.O_NOFOLLOW/u);
  assert.match(installer, /before\.nlink !== 1 \|\| before\.uid !== 0 \|\| before\.gid !== 0/u);
  assert.match(installer, /!\[0o400, 0o600\]\.includes\(mode\)/u);
  assert.match(installer, /query_unit_active_state vpn-sub\.service/u);
  assert.match(installer, /query_upgrade_enablement vpn-sub\.service yes yes/u);
  assert.match(installer, /runtimeGid: Number\(process\.env\.RUNTIME_GID\)/u);
  assert.match(installer, /subscriptionGid: Number\(process\.env\.SUB_GID\)/u);
  assert.match(installer, /sync -f "\$MIGRATION_MARKER\/state-copied"/u);
  assert.match(installer, /sync -f "\$MIGRATION_MARKER\/state-published"/u);
  assert.match(installer, /sync -f "\$MIGRATION_MARKER\/committed"/u);
  assert.match(
    installer,
    /if \[\[ "\$MIGRATION_RESUME" == yes \]\]; then[\s\S]*STATE_COPY_ALREADY_COMPLETE=no[\s\S]*if \[\[ "\$STATE_COPY_ALREADY_COMPLETE" != yes \]\]; then/u,
    'every resumed legacy migration must refresh mutable Tailscale state after quiescing its source',
  );
  assert.match(
    installer,
    /assert_distinct_migration_state_trees\(\) \{[\s\S]*stat -Lc '%d:%i' -- "\$source_tree"[\s\S]*stat -Lc '%d:%i' -- "\$destination_tree"[\s\S]*"\$source_identity" != "\$destination_identity"/u,
    'legacy state separation must reject symlinked-ancestor and bind-mount aliases by device and inode',
  );
  const earlyStateAliasCheck = installer.indexOf(
    'assert_distinct_migration_state_trees "$LEGACY_SOURCE_STATE" "$STATE_ROOT/tailscale"',
  );
  const migrationApproval = installer.indexOf('case "${MIGRATE_LEGACY:-}" in');
  const replacementStateAliasCheck = installer.indexOf(
    'assert_distinct_migration_state_trees "$LEGACY_SOURCE_STATE" "$STATE_ROOT/tailscale"',
    earlyStateAliasCheck + 1,
  );
  const destructiveStateReplacement = installer.indexOf(
    'rm -rf -- "$STATE_ROOT/tailscale"',
    replacementStateAliasCheck,
  );
  assert.ok(
    earlyStateAliasCheck > 0
      && migrationApproval > earlyStateAliasCheck
      && replacementStateAliasCheck > migrationApproval
      && destructiveStateReplacement > replacementStateAliasCheck,
    'state-tree alias rejection must run during read-only review and again immediately before replacement',
  );
  assert.match(
    installer.slice(replacementStateAliasCheck, destructiveStateReplacement + 40),
    /assert_distinct_migration_state_trees "\$LEGACY_SOURCE_STATE" "\$STATE_ROOT\/tailscale"\s*\n\s*rm -rf -- "\$STATE_ROOT\/tailscale"/u,
    'the final device/inode check must be adjacent to destructive state replacement',
  );
  assert.match(
    installer,
    /create_admin_environment\(\) \{[\s\S]*write_environment_value ADMIN_PUBLIC_HOSTNAME "\$ADMIN_PUBLIC_HOSTNAME" >"\$temporary_file"/u,
  );
  assert.doesNotMatch(installer, /ADMIN_ALLOWED_HOSTS|ADMIN_ALLOWED_ORIGINS/u);
  assert.doesNotMatch(installer, /ADMIN_SECURE_COOKIE/u);
  assert.ok(
    installer.indexOf('recover_interrupted_upgrade_rollback\n')
      < installer.indexOf('trap restore_previous_deployment_on_failure EXIT'),
    'persistent rollback recovery must run before ordinary upgrade/service handling',
  );
  const interruptedRollbackRecovery = installer.indexOf('recover_interrupted_upgrade_rollback\n');
  const tunnelIdentityAudit = installer.indexOf(
    'validate_service_namespace vpn-tunnel "$EXPECTED_TUNNEL_UID" "$EXPECTED_TUNNEL_GID" no',
  );
  const tunnelIdentityCreation = installer.indexOf('ensure_group vpn-tunnel 11003');
  assert.ok(
    interruptedRollbackRecovery > 0
      && tunnelIdentityAudit > interruptedRollbackRecovery
      && tunnelIdentityCreation > tunnelIdentityAudit,
    'pre-tunnel rollback journals must replay before uid/gid 11003 is audited or created',
  );
  const initialTokenSelection = installer.indexOf('TUNNEL_TOKEN_RECOVERY_PENDING=no');
  const deferredTokenValidation = installer.indexOf(
    'if [[ "$TUNNEL_TOKEN_RECOVERY_PENDING" == yes ]]; then',
    interruptedRollbackRecovery,
  );
  assert.ok(
    initialTokenSelection > 0
      && installer.indexOf('TUNNEL_TOKEN_RECOVERY_PENDING=yes', initialTokenSelection)
        < interruptedRollbackRecovery
      && deferredTokenValidation > interruptedRollbackRecovery,
    'stored Tunnel token validation must be deferred until predecessor journal replay completes',
  );
  const commitPromotionCall = installer.indexOf('  promote_interrupted_migration_commit\n');
  const installModeClassification = installer.indexOf('INSTALL_MODE=fresh');
  assert.ok(
    commitPromotionCall > 0 && commitPromotionCall < installModeClassification,
    'a durable inner legacy commit must be promoted before install-mode classification or bootstrap',
  );
  const commitPromotionStart = installer.indexOf('promote_interrupted_migration_commit() {');
  const tokenValidatorStart = installer.indexOf(
    'validate_cloudflare_tunnel_token_file() {',
    commitPromotionStart,
  );
  const commitPromotionBody = installer.slice(commitPromotionStart, tokenValidatorStart);
  const strictCommitValidation = commitPromotionBody.indexOf(
    'validate_migration_marker_file "$MIGRATION_MARKER/$marker_name"',
  );
  const emptyCommitValidation = commitPromotionBody.indexOf(
    'Migration phase marker $marker_name must be empty.',
  );
  const commitPromotion = commitPromotionBody.indexOf(
    'mv -T -- "$inner_commit" "$MIGRATION_COMMITTED_MARKER"',
  );
  const sourceDirectorySync = commitPromotionBody.indexOf(
    'sync -f "$MIGRATION_MARKER"',
    commitPromotion,
  );
  const commitDirectorySync = commitPromotionBody.indexOf(
    'sync -f "$STATE_ROOT"',
    sourceDirectorySync,
  );
  assert.ok(
    strictCommitValidation > 0
      && emptyCommitValidation > strictCommitValidation
      && commitPromotion > emptyCommitValidation
      && sourceDirectorySync > commitPromotion
      && commitDirectorySync > sourceDirectorySync,
    'inner commit promotion must validate exact marker contents and durably sync both rename parents',
  );
  const migrationResume = installer.indexOf('if [[ "$MIGRATION_RESUME" == yes ]]; then');
  const migrationResumeQuiesce = installer.indexOf(
    'stop_unit_if_active_strict vpn-gateway-tunnel.service yes',
    migrationResume,
  );
  const sourceInstallation = installer.indexOf(
    'install -o root -g root -m 0644 "$REPO_DIR/package.json" "$INSTALL_ROOT/package.json"',
  );
  assert.ok(
    migrationResume > 0
      && installer.indexOf('LEGACY_SERVICES_STOPPED=yes', migrationResume) < migrationResumeQuiesce
      && installer.indexOf('hold_migration_target_disabled', migrationResume) < migrationResumeQuiesce
      && migrationResumeQuiesce < sourceInstallation,
    'an uncommitted migration resume must quiesce every replacement unit before code or state mutation',
  );
  const codeFlush = installer.lastIndexOf('sync -f /opt\n');
  const environmentFlush = installer.lastIndexOf('sync -f /etc\n');
  const commit = installer.lastIndexOf('commit_upgrade_rollback_transaction\n');
  assert.ok(
    codeFlush > 0 && environmentFlush > codeFlush && commit > environmentFlush,
    'code and environment filesystems must flush before the durable upgrade commit',
  );
  const migrationBranch = installer.lastIndexOf('if [[ "$INSTALL_MODE" == migrate ]]; then\n');
  const migrationCodeFlush = installer.indexOf('sync -f /opt\n', migrationBranch);
  const migrationEnvironmentFlush = installer.indexOf('sync -f /etc\n', migrationCodeFlush);
  const migrationCommit = installer.indexOf('mv -- "$MIGRATION_MARKER/committed" "$MIGRATION_COMMITTED_MARKER"', migrationEnvironmentFlush);
  assert.ok(
    migrationBranch > 0
      && migrationCodeFlush > migrationBranch
      && migrationEnvironmentFlush > migrationCodeFlush
      && migrationCommit > migrationEnvironmentFlush,
    'code and environment filesystems must flush before the durable migration commit',
  );
  const restartIntent = installer.lastIndexOf('prepare_upgrade_restart_journal\n');
  const bootHold = installer.lastIndexOf('hold_upgrade_services_disabled\n');
  const serviceStop = installer.indexOf('quiesce_upgrade_services_for_rollback\n', bootHold);
  const protectedSnapshot = installer.lastIndexOf('backup_upgrade_protected_state\n');
  const rollbackJournal = installer.lastIndexOf('begin_upgrade_rollback_transaction\n');
  assert.ok(
    restartIntent < bootHold
      && bootHold < serviceStop
      && serviceStop < protectedSnapshot
      && protectedSnapshot < rollbackJournal,
    'durable restart intent and boot disablement must precede shutdown and protected-state handoff',
  );
  const deploymentRestoreStart = installer.indexOf('restore_upgrade_deployment_files() {');
  const enablementRestoreStart = installer.indexOf(
    'restore_upgrade_enablement() {',
    deploymentRestoreStart,
  );
  const deploymentRestoreBody = installer.slice(deploymentRestoreStart, enablementRestoreStart);
  assert.doesNotMatch(
    deploymentRestoreBody,
    /restore_upgrade_enablement/u,
    'restoring predecessor files must not make the uncommitted rollback bootable',
  );
  const activeRollbackStart = installer.indexOf('rollback_active_upgrade_transaction() {');
  const committedArchiveStart = installer.indexOf(
    'archive_committed_upgrade_journal() {',
    activeRollbackStart,
  );
  const activeRollbackBody = installer.slice(activeRollbackStart, committedArchiveStart);
  const rollbackQuiesce = activeRollbackBody.indexOf('quiesce_upgrade_services_for_rollback');
  const rollbackBootHold = activeRollbackBody.indexOf('hold_upgrade_services_disabled yes');
  const rollbackStateRestore = activeRollbackBody.indexOf('restore_upgrade_protected_state');
  const rollbackFilesRestore = activeRollbackBody.lastIndexOf('restore_upgrade_deployment_files');
  const rollbackRestoredMarker = activeRollbackBody.indexOf('mark_upgrade_rollback_restored');
  const rollbackEnablement = activeRollbackBody.indexOf('restore_upgrade_enablement');
  const rollbackRestart = activeRollbackBody.indexOf('restart_and_verify_restored_upgrade');
  assert.ok(
    rollbackBootHold > 0
      && rollbackQuiesce > rollbackBootHold
      && rollbackStateRestore > rollbackQuiesce
      && rollbackFilesRestore > rollbackStateRestore
      && rollbackRestoredMarker > rollbackFilesRestore
      && rollbackEnablement > rollbackRestoredMarker
      && rollbackRestart > rollbackEnablement,
    'rollback must stay boot-disabled until restored state and files have a durable marker',
  );
  const quiesceStart = installer.indexOf('quiesce_upgrade_services_for_rollback() {');
  const restoredRestartStart = installer.indexOf(
    'restart_and_verify_restored_upgrade() {',
    quiesceStart,
  );
  const quiesceBody = installer.slice(quiesceStart, restoredRestartStart);
  assert.match(
    quiesceBody,
    /stop_unit_if_active_strict "\$service_name" yes/u,
    'rollback replay must tolerate a unit absent after an interrupted file restore',
  );
  assert.match(quiesceBody, /stop_unit_if_active_strict vpn-gateway-tunnel\.service yes/u);
  const bootHoldStart = installer.indexOf('hold_upgrade_services_disabled() {');
  const migrationBootHoldStart = installer.indexOf(
    'hold_migration_target_disabled() {',
    bootHoldStart,
  );
  const bootHoldBody = installer.slice(bootHoldStart, migrationBootHoldStart);
  assert.match(bootHoldBody, /local allow_not_found="\$\{1:-no\}"/u);
  assert.match(
    bootHoldBody,
    /enablement_link="\$SYSTEMD_ROOT\/multi-user\.target\.wants\/\$unit_name"[\s\S]*rm -f -- "\$enablement_link"/u,
    'rollback boot hold must remove a dangling enablement link before a missing unit is restored',
  );
  assert.match(
    bootHoldBody,
    /"\$allow_not_found" == yes && "\$target_state" == not-found/u,
    'rollback replay must preserve boot hold even when a target file restore was interrupted',
  );
  assert.match(repository, /const PRIVATE_GID = SERVICE_UID === 0 \? 0 : SERVICE_GID/u);
  assert.match(repository, /await handle\.chown\(ownerUid, ownerGid\)/u);
  assert.match(controller, /normalizePrivateHandle\(handle, 'maintenance marker'\)/u);
  assert.match(controllerUnit, /ExecStartPre=.*node \/opt\/vpn-gateway\/src\/state\/bootstrap\.js/u);
  assert.match(controllerUnit, /ExecStart=.*node \/opt\/vpn-gateway\/src\/control\/controller-server\.js/u);
  assert.match(controllerUnit, /^Group=root$/mu);
  assert.match(controllerUnit, /^RuntimeDirectoryMode=0751$/mu);
  assert.match(controllerUnit, /ExecStartPost=\/usr\/bin\/systemctl --no-block start vpn-gateway-subscription\.service vpn-gateway-admin\.service vpn-gateway-tunnel\.service/u);
  assert.match(adminUnit, /BindsTo=vpn-gateway-controller\.service/u);
  assert.match(adminUnit, /After=vpn-gateway-controller\.service/u);
  assert.match(subscriptionUnit, /BindsTo=vpn-gateway-controller\.service/u);
  assert.match(subscriptionUnit, /After=vpn-gateway-controller\.service/u);
  assert.match(singBoxUnit, /BindsTo=vpn-gateway-controller\.service/u);
  assert.doesNotMatch(singBoxUnit, /^After=.*vpn-gateway-controller\.service/mu);
  assert.match(adminUnit, /node \/opt\/vpn-gateway\/src\/http\/admin-server\.js/u);
  assert.match(subscriptionUnit, /node \/opt\/vpn-gateway\/src\/http\/subscription-server\.js/u);
});

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
  ] = await Promise.all([
    readProjectFile('deploy/docker/Dockerfile'),
    readProjectFile('docker-compose.yml'),
    readProjectFile('deploy/docker/entrypoint.sh'),
    readProjectFile('deploy/docker/cloudflared.Dockerfile'),
    readProjectFile('deploy/docker/cloudflared-guard.go'),
    readProjectFile('deploy/docker/compose-up.sh'),
    readProjectFile('.dockerignore'),
    readProjectFile('.env.example'),
  ]);

  assert.match(dockerfile, /FROM node:24\.20\.0-alpine3\.24@sha256:[0-9a-f]{64}/u);
  assert.match(dockerfile, /github\.com\/sagernet\/sing-box\/cmd\/sing-box@v1\.13\.21/u);
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
    /FROM cloudflare\/cloudflared:2026\.8\.3@sha256:51c9cefcb4569df44e1ad403ab1d3d8065aa8e84339bcfc6aee75502e1140339/u,
  );
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
