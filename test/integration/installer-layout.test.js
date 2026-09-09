import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertInstallerMatches, assertInstallerExcludes, installerFunction, installerPosition, installerLastPosition } from '../fixtures/installer.js';

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const readProjectFile = (relativePath) => readFile(path.join(projectRoot, relativePath), 'utf8');

test('supported Node policy and bare-metal ES-module layout stay aligned', async () => {
  const [
    packageText,
    controllerUnit,
    singBoxUnit,
    adminUnit,
    subscriptionUnit,
    repositoryPolicy,
    repositoryFiles,
    controllerFiles,
  ] = await Promise.all([
    readProjectFile('package.json'),
    readProjectFile('deploy/systemd/vpn-gateway-controller.service'),
    readProjectFile('deploy/systemd/vpn-gateway-sing-box.service'),
    readProjectFile('deploy/systemd/vpn-gateway-admin.service'),
    readProjectFile('deploy/systemd/vpn-gateway-subscription.service'),
    readProjectFile('src/state/filesystem/policy.js'),
    readProjectFile('src/state/filesystem/files.js'),
    readProjectFile('src/control/authority/operational-files.js'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.engines.node, '>=24.20.0 <25');
  assertInstallerMatches(/readonly MIN_NODE_VERSION=24\.20\.0/u);
  assertInstallerMatches(/NODE_MAJOR != 24 \|\| NODE_MINOR < 20/u);
  assertInstallerMatches(/install -o root -g root -m 0644 "\$REPO_DIR\/package\.json" "\$INSTALL_ROOT\/package\.json"/u);
  assertInstallerMatches(/passwd_records="\$\(getent passwd\)"/u);
  assertInstallerMatches(/group_records="\$\(getent group\)"/u);
  assertInstallerMatches(/Service gid \$expected_gid is the primary gid of passwd principal/u);
  assertInstallerMatches(/Service group \$service_name contains unauthorized member/u);
  assertInstallerMatches(/passwd -S "\$service_name"/u);
  assertInstallerMatches(/\/usr\/sbin\/nologin\|\/sbin\/nologin\|\/usr\/bin\/false\|\/bin\/false/u);
  assertInstallerMatches(/UPGRADE_ROLLBACK_JOURNAL="\$STATE_ROOT\/\.upgrade-rollback-in-progress"/u);
  assertInstallerMatches(/UPGRADE_RESTART_JOURNAL="\$STATE_ROOT\/\.upgrade-restart-in-progress"/u);
  assertInstallerMatches(/INSTALLER_LOCK=\/run\/vpn-gateway-installer\.lock/u);
  assertInstallerMatches(/flock -n "\$INSTALLER_LOCK_FD"/u);
  assertInstallerMatches(/\(8#\$run_mode & 8#022\) != 0/u);
  assertInstallerMatches(/begin_upgrade_rollback_transaction\s*\nfi\s*\n\s*install -d/u);
  assertInstallerMatches(/sync -f "\$UPGRADE_ROLLBACK_JOURNAL"/u);
  assertInstallerMatches(/\.revisions-restore-build\.\$restore_token\.XXXXXXXXXX/u);
  assertInstallerMatches(/reconcile_repository_revision_crash_artifacts "\$STATE_ROOT\/revisions"/u);
  assertInstallerMatches(/normalize_upgrade_repository_ownership/u);
  assertInstallerMatches(/mark_upgrade_rollback_restored/u);
  assertInstallerMatches(/constants\.O_RDONLY \| constants\.O_NOFOLLOW/u);
  assertInstallerMatches(/before\.nlink !== 1 \|\| before\.uid !== 0 \|\| before\.gid !== 0/u);
  assertInstallerMatches(/!\[0o400, 0o600\]\.includes\(mode\)/u);
  assertInstallerMatches(/systemctl show "\$retired_unit" --property=LoadState --value/u);
  assertInstallerExcludes(/INSTALL_MODE=migrate|MIGRATION_|MIGRATE_/u);
  assertInstallerMatches(
    /create_admin_environment\(\) \{[\s\S]*write_environment_value ADMIN_PUBLIC_HOSTNAME "\$ADMIN_PUBLIC_HOSTNAME" >"\$temporary_file"/u,
  );
  assertInstallerExcludes(/ADMIN_ALLOWED_HOSTS|ADMIN_ALLOWED_ORIGINS/u);
  assertInstallerExcludes(/ADMIN_SECURE_COOKIE/u);
  assert.ok(
    installerPosition('recover_interrupted_upgrade_rollback\n')
      < installerPosition('trap restore_previous_deployment_on_failure EXIT'),
    'persistent rollback recovery must run before ordinary upgrade/service handling',
  );
  const interruptedRollbackRecovery = installerPosition('recover_interrupted_upgrade_rollback\n');
  const tunnelIdentityAudit = installerPosition(
    'validate_service_namespace vpn-tunnel "$EXPECTED_TUNNEL_UID" "$EXPECTED_TUNNEL_GID" no',
  );
  const tunnelIdentityCreation = installerPosition('ensure_group vpn-tunnel 11003');
  assert.ok(
    interruptedRollbackRecovery > 0
      && tunnelIdentityAudit > interruptedRollbackRecovery
      && tunnelIdentityCreation > tunnelIdentityAudit,
    'pre-tunnel rollback journals must replay before uid/gid 11003 is audited or created',
  );
  const initialTokenSelection = installerPosition('TUNNEL_TOKEN_RECOVERY_PENDING=no');
  const deferredTokenValidation = installerPosition(
    'if [[ "$TUNNEL_TOKEN_RECOVERY_PENDING" == yes ]]; then',
    interruptedRollbackRecovery,
  );
  assert.ok(
    initialTokenSelection > 0
      && installerPosition('TUNNEL_TOKEN_RECOVERY_PENDING=yes', initialTokenSelection)
        < interruptedRollbackRecovery
      && deferredTokenValidation > interruptedRollbackRecovery,
    'stored Tunnel token validation must be deferred until predecessor journal replay completes',
  );
  const codeFlush = installerLastPosition('sync -f /opt\n');
  const environmentFlush = installerLastPosition('sync -f /etc\n');
  const commit = installerLastPosition('commit_upgrade_rollback_transaction\n');
  assert.ok(
    codeFlush > 0 && environmentFlush > codeFlush && commit > environmentFlush,
    'code and environment filesystems must flush before the durable upgrade commit',
  );
  const restartIntent = installerLastPosition('prepare_upgrade_restart_journal\n');
  const bootHold = installerLastPosition('hold_upgrade_services_disabled\n');
  const serviceStop = installerPosition('quiesce_upgrade_services_for_rollback\n', bootHold);
  const protectedSnapshot = installerLastPosition('backup_upgrade_protected_state\n');
  const rollbackJournal = installerLastPosition('begin_upgrade_rollback_transaction\n');
  assert.ok(
    restartIntent < bootHold
      && bootHold < serviceStop
      && serviceStop < protectedSnapshot
      && protectedSnapshot < rollbackJournal,
    'durable restart intent and boot disablement must precede shutdown and protected-state handoff',
  );
  const deploymentRestoreBody = installerFunction('restore_upgrade_deployment_files');
  assert.doesNotMatch(
    deploymentRestoreBody,
    /restore_upgrade_enablement/u,
    'restoring predecessor files must not make the uncommitted rollback bootable',
  );
  const activeRollbackBody = installerFunction('rollback_active_upgrade_transaction');
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
  const quiesceBody = installerFunction('quiesce_upgrade_services_for_rollback');
  assert.match(
    quiesceBody,
    /stop_unit_if_active_strict "\$service_name" yes/u,
    'rollback replay must tolerate a unit absent after an interrupted file restore',
  );
  assert.match(quiesceBody, /stop_unit_if_active_strict vpn-gateway-tunnel\.service yes/u);
  const bootHoldBody = installerFunction('hold_upgrade_services_disabled');
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
  assert.match(repositoryPolicy, /const PRIVATE_GID = SERVICE_UID === 0 \? 0 : SERVICE_GID/u);
  assert.match(repositoryFiles, /await handle\.chown\(ownerUid, ownerGid\)/u);
  assert.match(controllerFiles, /normalizePrivateHandle\(handle, 'maintenance marker'\)/u);
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
