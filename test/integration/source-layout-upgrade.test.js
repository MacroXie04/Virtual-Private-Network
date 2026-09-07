import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { installerEntry, installerFunction, installerModule } from '../fixtures/installer.js';

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const installer = installerEntry;
const nativeOwnership = process.platform === 'linux' && process.getuid?.() === 0;

const sourceModule = installerModule('source-installation');
const sourceStart = sourceModule.indexOf('\nvalidate_fixed_directory "$INSTALL_ROOT/src"\ninstall -o root');
assert.ok(sourceStart > 0);
const sourceInstallation = sourceModule.slice(sourceStart);

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vpn-source-layout-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = ['installed/src', 'installed/bin', 'environment', 'units', 'backup/units'];
  await Promise.all(directories.map((directory) => mkdir(path.join(root, directory), { recursive: true })));
  return root;
}

async function runInstaller(root, body) {
  // Exercise the actual source-copy and rollback code only inside disposable
  // trees. Host service changes and filesystem flushes are explicitly stubbed.
  // Linux root runs retain real ownership checks; ordinary npm test runs omit
  // ownership changes while still copying files and applying their real modes.
  const ownership = nativeOwnership
    ? `${installerFunction('validate_fixed_directory')}\n${installerFunction('validate_fixed_file')}`
    : `
validate_fixed_directory() {
  path_is_present "$1" || return 0
  [[ -d "$1" && ! -L "$1" ]] || die "Unsafe fixture directory: $1"
}
validate_fixed_file() {
  path_is_present "$1" || return 0
  [[ -f "$1" && ! -L "$1" ]] || die "Unsafe fixture file: $1"
}
install() {
  local -a arguments=()
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -o|-g) shift 2 ;;
      *) arguments+=("$1"); shift ;;
    esac
  done
  command install "\${arguments[@]}"
}
chown() { :; }
`;
  return execFile('bash', ['-c', `
set -euo pipefail
readonly INSTALL_ROOT="$TEST_ROOT/installed"
readonly ENV_ROOT="$TEST_ROOT/environment"
readonly SYSTEMD_ROOT="$TEST_ROOT/units"
readonly UPGRADE_BACKUP="$TEST_ROOT/backup"
readonly UPGRADE_HAD_INSTALL_ROOT=yes
readonly UPGRADE_HAD_ENV_ROOT=yes
readonly -a UNIT_FILES=(vpn-gateway-controller.service)
die() { echo "$*" >&2; exit 1; }
path_is_present() { [[ -e "$1" || -L "$1" ]]; }
${ownership}
validate_upgrade_rollback_backup() {
  [[ -d "$UPGRADE_BACKUP/install-root" && ! -L "$UPGRADE_BACKUP/install-root" ]] \\
    || die 'Missing fixture backup'
}
sync() {
  [[ "$#" -eq 2 && "$1" == -f && ( "$2" == /opt || "$2" == /etc ) ]] \\
    || die 'Unexpected host flush'
}
systemctl() {
  [[ "$#" -eq 1 && "$1" == daemon-reload ]] || die 'Unexpected service operation'
}
${installerFunction('remove_retired_source_files')}
${installerFunction('restore_upgrade_deployment_files')}
${body}
`], {
    cwd: root,
    env: { ...process.env, TEST_ROOT: root, REPO_DIR: projectRoot },
    timeout: 20_000,
    maxBuffer: 128 * 1024,
  });
}

async function treeSnapshot(root) {
  const entries = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) {
      entries.push([relative, 'directory', metadata.mode & 0o777]);
      for (const name of (await readdir(absolute)).sort()) {
        await visit(path.join(relative, name));
      }
    } else {
      assert.ok(metadata.isFile(), `fixture entry ${relative} is a regular file`);
      entries.push([relative, 'file', metadata.mode & 0o777, (await readFile(absolute)).toString('base64')]);
    }
  }
  await visit('');
  return entries;
}

async function oldSourceFiles() {
  // This is the historical flat checkout, not a flattening of today's source.
  // New nested modules never existed at the retired top-level paths.
  return [
    'admin-page.js', 'admin-server.js', 'bootstrap.js', 'control-client.js',
    'controller-server.js', 'controller-sessions.js', 'controller.js', 'credentials.js',
    'health-probe.js', 'healthcheck.js', 'http-common.js', 'legacy-reality.js',
    'legacy-v2.js', 'lifecycle.js', 'migrate-v1.js', 'render.js', 'repository.js',
    'runtime.js', 'state-schema.js', 'subscription-server.js', 'tailscale.js',
    'validation.js', 'websocket-probe.js',
  ];
}

const retiredNestedFiles = ['core/render.js', 'http/http-common.js', 'migrations/legacy-v2.js'];

async function writeSourceFiles(root, filenames, content) {
  for (const filename of filenames) {
    const absolute = path.join(root, 'installed/src', filename);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

test('fresh source installation copies nested modules with the package and executable wrapper', async (t) => {
  const root = await fixture(t);
  await runInstaller(root, sourceInstallation);
  const installedSource = await treeSnapshot(path.join(root, 'installed/src'));
  assert.deepEqual(
    installedSource,
    await treeSnapshot(path.join(projectRoot, 'src')),
  );
  assert.equal(JSON.parse(await readFile(path.join(root, 'installed/package.json'), 'utf8')).type, 'module');
  assert.equal((await lstat(path.join(root, 'installed/bin/sing-box-wrapper'))).mode & 0o777, 0o755);
  if (nativeOwnership) {
    for (const [relative] of installedSource) {
      const metadata = await lstat(path.join(root, 'installed/src', relative));
      assert.deepEqual([metadata.uid, metadata.gid], [0, 0], `${relative || 'src/'} stays root-owned`);
    }
  }
  await execFile(process.execPath, ['--input-type=module', '--eval', 'await import("./src/core/server-render.js")'], {
    cwd: path.join(root, 'installed'),
    timeout: 10_000,
  });
});

for (const layout of ['flat', 'nested']) {
  test(`source upgrade removes every retired ${layout} module and preserves unrelated files and state`, async (t) => {
    const root = await fixture(t);
    const retired = layout === 'flat' ? await oldSourceFiles() : retiredNestedFiles;
    const preserved = ['operator-hook.js', 'exit-profiles.js', 'core/operator-hook.js', 'http/operator-hook.js', 'migrations/operator-hook.js'];
    await writeSourceFiles(root, retired, 'old source\n');
    await writeSourceFiles(root, preserved, '// operator extension\n');
    await writeFile(path.join(root, 'environment/credentials.env'), 'keep existing credentials\n');
    await runInstaller(root, sourceInstallation);
    for (const filename of retired) {
      await assert.rejects(lstat(path.join(root, 'installed/src', filename)), { code: 'ENOENT' });
    }
    const firstInstall = await treeSnapshot(path.join(root, 'installed'));
    await runInstaller(root, sourceInstallation);
    assert.deepEqual(await treeSnapshot(path.join(root, 'installed')), firstInstall);
    for (const filename of preserved) {
      assert.equal(await readFile(path.join(root, 'installed/src', filename), 'utf8'), '// operator extension\n');
    }
    assert.equal(await readFile(path.join(root, 'environment/credentials.env'), 'utf8'), 'keep existing credentials\n');
  });

  test(`failed source upgrade restores the exact ${layout} predecessor and its original units`, async (t) => {
    const root = await fixture(t);
    const controller = layout === 'flat' ? 'controller-server.js' : 'control/controller-server.js';
    const retired = layout === 'flat' ? await oldSourceFiles() : retiredNestedFiles;
    await writeSourceFiles(root, retired, 'old source\n');
    await writeSourceFiles(root, [controller, 'operator-hook.js'], 'old controller and extension\n');
    await writeFile(path.join(root, 'installed/package.json'), '{"type":"module","version":"old"}\n');
    await writeFile(path.join(root, 'environment/controller.env'), 'old environment\n');
    await writeFile(path.join(root, 'units/vpn-gateway-controller.service'), `ExecStart=node /opt/vpn-gateway/src/${controller}\n`);
    const originalInstall = await treeSnapshot(path.join(root, 'installed'));
    const originalEnvironment = await treeSnapshot(path.join(root, 'environment'));
    const originalUnits = await treeSnapshot(path.join(root, 'units'));
    await cp(path.join(root, 'installed'), path.join(root, 'backup/install-root'), { recursive: true });
    await cp(path.join(root, 'environment'), path.join(root, 'backup/environment-root'), { recursive: true });
    await cp(path.join(root, 'units/vpn-gateway-controller.service'), path.join(root, 'backup/units/vpn-gateway-controller.service'));
    await runInstaller(root, `
  trap restore_upgrade_deployment_files EXIT
  ${sourceInstallation}
  ${retired.map((filename) => `[[ ! -e "$INSTALL_ROOT/src/${filename}" ]] || exit 43`).join('\n')}
  printf '%s\\n' 'replacement unit' >"$SYSTEMD_ROOT/vpn-gateway-controller.service"
  printf '%s\\n' 'replacement environment' >"$ENV_ROOT/controller.env"
  exit 42
  `).then(() => assert.fail('the injected deployment failure must fail'), (error) => assert.equal(error.code, 42));
    assert.deepEqual(await treeSnapshot(path.join(root, 'installed')), originalInstall);
    assert.deepEqual(await treeSnapshot(path.join(root, 'environment')), originalEnvironment);
    assert.deepEqual(await treeSnapshot(path.join(root, 'units')), originalUnits);
  });
}

for (const candidate of ['websocket-probe.js', ...retiredNestedFiles]) {
  test(`retired-source cleanup rejects symlink ${candidate} before removing any old module`, async (t) => {
    const root = await fixture(t);
    const outside = path.join(root, 'outside.js');
    await writeFile(outside, 'must remain untouched\n');
    const preserved = ['admin-page.js', ...retiredNestedFiles.filter((file) => file !== candidate)];
    await writeSourceFiles(root, preserved, 'old source\n');
    await mkdir(path.join(root, 'installed/src', path.dirname(candidate)), { recursive: true });
    await symlink(outside, path.join(root, 'installed/src', candidate));
    await assert.rejects(runInstaller(root, 'remove_retired_source_files'), /must be a regular file, not a symlink/u);
    for (const filename of preserved) {
      assert.equal(await readFile(path.join(root, 'installed/src', filename), 'utf8'), 'old source\n');
    }
    assert.equal(await readFile(outside, 'utf8'), 'must remain untouched\n');
    assert.equal((await lstat(path.join(root, 'installed/src', candidate))).isSymbolicLink(), true);
  });
}

for (const candidate of retiredNestedFiles) {
  test(`retired-source cleanup rejects a symlink parent of ${candidate} before removing any old module`, async (t) => {
    const root = await fixture(t);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, path.basename(candidate)), 'must remain untouched\n');
    await writeSourceFiles(root, ['admin-page.js', ...retiredNestedFiles.filter((file) => file !== candidate)], 'old source\n');
    await symlink(outside, path.join(root, 'installed/src', path.dirname(candidate)));
    await assert.rejects(runInstaller(root, 'remove_retired_source_files'), /parent .* must be a real directory, not a symlink/u);
    for (const filename of ['admin-page.js', ...retiredNestedFiles]) {
      const content = filename === candidate ? 'must remain untouched\n' : 'old source\n';
      assert.equal(await readFile(path.join(root, 'installed/src', filename), 'utf8'), content);
    }
    assert.equal((await lstat(path.join(root, 'installed/src', path.dirname(candidate)))).isSymbolicLink(), true);
  });
}

test('deployment launchers locate the repository from an unrelated working directory', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'repository with spaces');
  const systemdDirectory = path.join(repo, 'deploy/systemd');
  const dockerDirectory = path.join(repo, 'deploy/docker');
  await mkdir(systemdDirectory, { recursive: true });
  await mkdir(dockerDirectory, { recursive: true });
  const installerPrefix = installer.slice(0, installer.indexOf('\nreadonly INSTALL_ROOT='));
  const installerPath = path.join(systemdDirectory, 'install.sh');
  await writeFile(installerPath, `${installerPrefix}\nprintf '%s' "$REPO_DIR"\n`);
  assert.equal((await execFile('bash', [installerPath], { cwd: root })).stdout, repo);

  const launcher = await readFile(new URL('../../deploy/docker/compose-up.sh', import.meta.url), 'utf8');
  const start = launcher.indexOf('SCRIPT_ROOT=');
  const end = launcher.indexOf('\n\ntoken_file=', start);
  assert.ok(start > 0 && end > start);
  const launcherPath = path.join(dockerDirectory, 'compose-up.sh');
  await writeFile(launcherPath, `${launcher.slice(start, end)}\nprintf '%s' "$PROJECT_ROOT"\n`);
  assert.equal((await execFile('sh', [launcherPath], { cwd: root })).stdout, repo);
});
