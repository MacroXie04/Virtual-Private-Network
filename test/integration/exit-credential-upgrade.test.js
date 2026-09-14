import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { installerFunction, installerModule } from '../fixtures/installer.js';

const execFile = promisify(execFileCallback);
const installer = installerModule('configuration-installation');
const nativeOwnership = process.platform === 'linux' && process.getuid?.() === 0;


const upgradeStart = installer.indexOf('\n  existing)\n', installer.indexOf('\ninstall_cloudflare_tunnel_token\n'));
const upgradeEnd = installer.indexOf('\n    ;;', upgradeStart);
assert.ok(upgradeStart > 0 && upgradeEnd > upgradeStart);
const existingBranch = installer.slice(upgradeStart + '\n  existing)\n'.length, upgradeEnd);
const environmentStart = installer.indexOf('\nif [[ -s "$API_KEY_PATH" ]]; then\n', upgradeEnd);
const environmentEnd = installer.indexOf('\n\ncreate_admin_environment() {', environmentStart);
assert.ok(environmentStart > 0 && environmentEnd > environmentStart);
const apiEnvironment = installer.slice(environmentStart, environmentEnd);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vpn-exit-key-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'secrets'), { mode: 0o700 });
  return root;
}

async function upgrade(root, source = '', { native = false, rejectSource = false } = {}) {
  return execFile('bash', ['-c', `
set -euo pipefail
readonly SECRET_ROOT="$TEST_ROOT/secrets"
readonly ENV_ROOT="$TEST_ROOT"
readonly API_KEY_PATH="$SECRET_ROOT/tailscale-api-key"
readonly API_ENV="$ENV_ROOT/tailscale-api.env"
die() { echo "$*" >&2; exit 1; }
path_is_present() { [[ -e "$1" || -L "$1" ]]; }
sync() { [[ "$#" -eq 2 && "$1" == -f && "$2" == "$TEST_ROOT"/* ]]; }
create_existing_controller_environment() { touch "$TEST_ROOT/controller-created"; }
${installerFunction('write_environment_value')}
${installerFunction('write_api_environment')}
${native ? installerFunction('create_secret_file') : `
chown() { :; }
create_secret_file() {
  printf '%s\\n' "$@" >"$TEST_ROOT/copy-arguments"
  [[ "$TEST_REJECT_SOURCE" == no ]] || return 71
  cp "$TS_API_KEY_FILE" "$1"
  chmod 0600 "$1"
}
`}
${existingBranch}
${apiEnvironment}
`], {
    env: { ...process.env, TEST_ROOT: root, TS_API_KEY_FILE: source, NODE_BIN: process.execPath, TEST_REJECT_SOURCE: rejectSource ? 'yes' : 'no' },
    timeout: 10_000,
    maxBuffer: 32 * 1024,
  });
}

test('existing deployment installs an explicit API credential and preserves it when omitted', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source-key');
  const destination = path.join(root, 'secrets/tailscale-api-key');
  await writeFile(source, 'tskey-api-new-fixture', { mode: 0o600 });
  await writeFile(destination, 'tskey-api-old-fixture', { mode: 0o600 });
  await upgrade(root, source);
  assert.equal(await readFile(destination, 'utf8'), 'tskey-api-new-fixture');
  assert.deepEqual((await readFile(path.join(root, 'copy-arguments'), 'utf8')).trim().split('\n'), [
    destination, 'TS_API_KEY_FILE', 'Tailscale API access token', 'yes',
  ]);
  assert.equal(await readFile(path.join(root, 'tailscale-api.env'), 'utf8'), `TS_API_KEY_FILE="${destination}"\n`);
  await upgrade(root);
  assert.equal(await readFile(destination, 'utf8'), 'tskey-api-new-fixture');
});

test('existing deployment does not swallow an explicitly supplied API credential failure', async (t) => {
  const root = await fixture(t);
  await assert.rejects(upgrade(root, path.join(root, 'rejected-source'), { rejectSource: true }), (error) => error.code === 71);
  await assert.rejects(lstat(path.join(root, 'controller-created')), (error) => error.code === 'ENOENT');
  await assert.rejects(lstat(path.join(root, 'tailscale-api.env')), (error) => error.code === 'ENOENT');
});

test('existing deployment validates and copies a real root-owned API credential', { skip: !nativeOwnership }, async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source-key');
  const destination = path.join(root, 'secrets/tailscale-api-key');
  await writeFile(source, 'tskey-api-native-fixture', { mode: 0o600 });
  await upgrade(root, source, { native: true });
  assert.equal(await readFile(destination, 'utf8'), 'tskey-api-native-fixture');
  const stat = await lstat(destination);
  assert.deepEqual([stat.uid, stat.gid, stat.mode & 0o777, stat.nlink], [0, 0, 0o600, 1]);
  const unsafeSource = path.join(root, 'unsafe-key');
  await writeFile(unsafeSource, 'tskey-api-unsafe-fixture', { mode: 0o644 });
  await assert.rejects(upgrade(root, unsafeSource, { native: true }));
  assert.equal(await readFile(destination, 'utf8'), 'tskey-api-native-fixture');
});
