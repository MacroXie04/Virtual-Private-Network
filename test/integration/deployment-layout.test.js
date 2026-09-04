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
    readProjectFile('server/install.sh'),
    readProjectFile('server/vpn-gateway-controller.service'),
    readProjectFile('server/vpn-gateway-sing-box.service'),
    readProjectFile('server/vpn-gateway-admin.service'),
    readProjectFile('server/vpn-gateway-subscription.service'),
    readProjectFile('src/repository.js'),
    readProjectFile('src/controller.js'),
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
  assert.match(installer, /ADMIN_ALLOWED_HOSTS="\$\{ADMIN_ALLOWED_HOSTS:-admin\.vpn\.invalid:8444\}"/u);
  assert.match(installer, /ADMIN_ALLOWED_ORIGINS="\$\{ADMIN_ALLOWED_ORIGINS:-https:\/\/admin\.vpn\.invalid:8444\}"/u);
  assert.doesNotMatch(installer, /ADMIN_SECURE_COOKIE/u);
  assert.ok(
    installer.indexOf('recover_interrupted_upgrade_rollback\n')
      < installer.indexOf('trap restore_previous_deployment_on_failure EXIT'),
    'persistent rollback recovery must run before ordinary upgrade/service handling',
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
  assert.match(repository, /const PRIVATE_GID = SERVICE_UID === 0 \? 0 : SERVICE_GID/u);
  assert.match(repository, /await handle\.chown\(ownerUid, ownerGid\)/u);
  assert.match(controller, /normalizePrivateHandle\(handle, 'maintenance marker'\)/u);
  assert.match(controllerUnit, /ExecStartPre=.*node \/opt\/vpn-gateway\/src\/bootstrap\.js/u);
  assert.match(controllerUnit, /ExecStart=.*node \/opt\/vpn-gateway\/src\/controller-server\.js/u);
  assert.match(controllerUnit, /^Group=root$/mu);
  assert.match(controllerUnit, /^RuntimeDirectoryMode=0751$/mu);
  assert.match(controllerUnit, /ExecStartPost=\/usr\/bin\/systemctl --no-block start vpn-gateway-subscription\.service vpn-gateway-admin\.service/u);
  assert.match(adminUnit, /BindsTo=vpn-gateway-controller\.service/u);
  assert.match(adminUnit, /After=vpn-gateway-controller\.service/u);
  assert.match(subscriptionUnit, /BindsTo=vpn-gateway-controller\.service/u);
  assert.match(subscriptionUnit, /After=vpn-gateway-controller\.service/u);
  assert.match(singBoxUnit, /BindsTo=vpn-gateway-controller\.service/u);
  assert.doesNotMatch(singBoxUnit, /^After=.*vpn-gateway-controller\.service/mu);
  assert.match(adminUnit, /node \/opt\/vpn-gateway\/src\/admin-server\.js/u);
  assert.match(subscriptionUnit, /node \/opt\/vpn-gateway\/src\/subscription-server\.js/u);
});

test('container pins supported runtimes and Compose preserves private service exposure', async () => {
  const [dockerfile, compose, entrypoint] = await Promise.all([
    readProjectFile('docker/Dockerfile'),
    readProjectFile('docker-compose.yml'),
    readProjectFile('docker/entrypoint.sh'),
  ]);

  assert.match(dockerfile, /FROM node:24\.20\.0-alpine3\.24@sha256:[0-9a-f]{64}/u);
  assert.match(dockerfile, /github\.com\/sagernet\/sing-box\/cmd\/sing-box@v1\.13\.21/u);
  assert.match(dockerfile, /with_tailscale/u);
  assert.match(compose, /- "443:8443\/tcp"/u);
  assert.match(compose, /- "127\.0\.0\.1:8080:8080\/tcp"/u);
  assert.match(compose, /- "127\.0\.0\.1:8081:8081\/tcp"/u);
  assert.match(compose, /SERVER_NAME: \$\{SERVER_NAME:\?Set SERVER_NAME in \.env\}/u);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/u);
  assert.match(compose, /read_only: true/u);
  assert.match(entrypoint, /canonical_revision_name/u);
  assert.match(entrypoint, /\$\{#canonical_revision_name\}" -eq 33/u);
  assert.match(entrypoint, /\^\[0-9\]\{16\}-\[0-9a-f\]\{16\}\$/u);
  assert.match(entrypoint, /bootstrap_credentials_required=no/u);
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
      EXIT_NODE: '100.64.0.10',
      VPS_HOST: 'vpn.example.com',
      SERVER_NAME: 'authorized-origin.example.com',
      NODE_NAME: 'vpn-test',
      PUBLIC_BASE_URL: '',
      MIGRATE_LEGACY: '',
    },
  });
});
