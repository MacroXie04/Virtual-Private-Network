import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { RevisionRepository } from '../../src/state/repository.js';
import { installerFunction, installerPosition } from '../fixtures/installer.js';
import { fixtureState } from '../fixtures/state.js';

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const nativeOwnership = process.platform === 'linux' && process.getuid?.() === 0;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vpn-supported-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function snapshot(root) {
  const result = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    result.push([
      relative, stat.mode, stat.uid, stat.gid, stat.ino, stat.mtimeMs, stat.ctimeMs,
      stat.isSymbolicLink() ? await readlink(absolute) : stat.isFile() ? (await readFile(absolute)).toString('base64') : null,
    ]);
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
    }
  }
  await visit('');
  return result;
}

async function writeUnsupportedSchema(revision, number) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, revision: number }));
  await writeFile(path.join(revision.path, 'state.json'), bytes, { mode: 0o600 });
  const manifestPath = path.join(revision.path, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files['state.json'] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
}

async function inspectState(root, surface) {
  if (surface === 'docker') {
    const entrypoint = await readFile(path.join(projectRoot, 'deploy/docker/entrypoint.sh'), 'utf8');
    const marker = "node --input-type=module --eval '\n";
    const start = entrypoint.indexOf(marker) + marker.length;
    const end = entrypoint.indexOf("\n'", start);
    assert.ok(start >= marker.length && end > start);
    assert.ok(end < entrypoint.indexOf('chown root:root "$DATA_ROOT"'));
    const script = entrypoint.slice(start, end)
      .replaceAll('"/data"', JSON.stringify(root))
      .replaceAll('"/app/src/', JSON.stringify(path.join(projectRoot, 'src/')).slice(0, -1));
    return execFile(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, SINGBOX_GID: '11000', SUB_GID: '11001' }, timeout: 10_000,
    });
  }
  return execFile('bash', ['-c', `
set -euo pipefail
resolve_service_id() { printf '%s' 11001; }
${installerFunction('assert_supported_data_directory')}
assert_supported_data_directory "$TEST_ROOT"
`], {
    env: { ...process.env, TEST_ROOT: root, REPO_DIR: projectRoot, NODE_BIN: process.execPath },
    timeout: 10_000,
  });
}

for (const surface of ['installer', 'docker']) {
  for (const marker of ['env', 'config.json', 'tsnet', '.legacy-migration-in-progress']) {
    test(`${surface} refuses unsupported ${marker} before changing files or permissions`, async (t) => {
      const root = await fixture(t);
      await writeFile(path.join(root, marker), 'preserve existing data\n', { mode: 0o600 });
      const before = await snapshot(root);
      await assert.rejects(inspectState(root, surface), /unsupported/u);
      assert.deepEqual(await snapshot(root), before);
    });
  }

  test(`${surface} accepts a fresh directory without creating repository or lock files`, async (t) => {
    const root = await fixture(t);
    const before = await snapshot(root);
    await inspectState(root, surface);
    assert.deepEqual(await snapshot(root), before);
  });

  test(`${surface} refuses either old authoritative pointer and preserves damaged current-format candidate recovery`, {
    skip: !nativeOwnership,
  }, async (t) => {
    const root = await fixture(t);
    const repository = new RevisionRepository(root, { runtimeGid: 11000, subscriptionGid: 11001 });
    const current = await repository.initialize(fixtureState());
    const candidate = await repository.createRevision(fixtureState({ revision: 2 }));
    await repository.activateRuntime(candidate.id);
    await writeFile(path.join(candidate.path, 'state.json'), 'damaged candidate\n', { mode: 0o600 });
    const damaged = await snapshot(root);
    await inspectState(root, surface);
    assert.deepEqual(await snapshot(root), damaged);

    await writeUnsupportedSchema(candidate, 2);
    const staged = path.join(root, 'revisions/.stage-00000000-0000-4000-8000-000000000001');
    await mkdir(staged, { mode: 0o700 });
    const mixed = await snapshot(root);
    await assert.rejects(inspectState(root, surface), /schema version 3/u);
    assert.deepEqual(await snapshot(root), mixed);

    await repository.activateRuntime(current.id);
    await writeUnsupportedSchema(current, 1);
    const oldCurrent = await snapshot(root);
    await assert.rejects(inspectState(root, surface), /schema version 3/u);
    assert.deepEqual(await snapshot(root), oldCurrent);
  });
}

for (const schemaVersion of [2, 3]) {
  test(`docker refuses unpointed schema ${schemaVersion} revisions before creating locks or changing existing data`, async (t) => {
    const root = await fixture(t);
    const revisionPath = path.join(root, 'revisions/0000000000000001-0000000000000001');
    await mkdir(revisionPath, { recursive: true, mode: 0o751 });
    await writeFile(path.join(revisionPath, 'state.json'), JSON.stringify({ schemaVersion, revision: 1 }), { mode: 0o600 });
    await mkdir(path.join(root, 'revisions/.stage-00000000-0000-4000-8000-000000000001'), { mode: 0o700 });
    const before = await snapshot(root);
    await assert.rejects(inspectState(root, 'docker'), /ORPHANED_REVISION/u);
    assert.deepEqual(await snapshot(root), before);
    await assert.rejects(lstat(path.join(root, 'controller.lock')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(root, 'tailscale')), { code: 'ENOENT' });
  });
}

test('installer refuses old paths and loaded unmanaged services without stopping or disabling them', async () => {
  for (const retiredPath of ['', '/etc/vpn-sub.env', '/etc/sing-box/config.json', '/var/lib/sing-box/tailscale', '/etc/sudoers.d/vpn-sub']) {
    for (const loadedUnit of ['', 'vpn-sub.service', 'sing-box.service']) {
      const request = execFile('bash', ['-c', `
set -euo pipefail
die() { echo "$*" >&2; exit 1; }
path_is_present() { [[ -n "$RETIRED_PATH" && "$1" == "$RETIRED_PATH" ]]; }
systemctl() {
  [[ "$#" == 4 && "$1" == show && "$3" == --property=LoadState && "$4" == --value ]] || exit 89
  if [[ "$2" == "$LOADED_UNIT" ]]; then printf loaded; else printf not-found; fi
}
${installerFunction('reject_retired_deployment')}
reject_retired_deployment
`], { env: { ...process.env, RETIRED_PATH: retiredPath, LOADED_UNIT: loadedUnit }, timeout: 10_000 });
      if (!retiredPath && !loadedUnit) await request;
      else await assert.rejects(request, /new data directory/u);
    }
  }
  assert.ok(installerPosition('reject_retired_deployment\n') < installerPosition('ensure_group vpn-runtime 11000'));
});

test('current upgrade backup validation refuses explicit old schemas without rewriting the backup', async (t) => {
  const root = await fixture(t);
  const statePath = path.join(root, 'state.json');
  for (const value of [{ schemaVersion: 3 }, { schemaVersion: 2 }, { schemaVersion: 1 }]) {
    await writeFile(statePath, JSON.stringify(value), { mode: 0o600 });
    const before = await snapshot(root);
    const request = execFile('bash', ['-c', `
set -euo pipefail
${installerFunction('assert_supported_revision_file')}
assert_supported_revision_file "$STATE_FILE"
`], { env: { ...process.env, STATE_FILE: statePath, NODE_BIN: process.execPath, REPO_DIR: projectRoot }, timeout: 10_000 });
    if (value.schemaVersion === 3) await request;
    else await assert.rejects(request, /Unsupported state schema/u);
    assert.deepEqual(await snapshot(root), before);
  }
});
