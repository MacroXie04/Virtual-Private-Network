import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { installerEntry, installerModuleNames } from '../fixtures/installer.js';

const execFile = promisify(execFileCallback);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vpn-installer-loading-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repository with spaces');
  const moduleDirectory = path.join(repo, 'deploy/systemd/installer');
  await mkdir(moduleDirectory, { recursive: true });
  const entry = path.join(repo, 'deploy/systemd/install.sh');
  await writeFile(entry, installerEntry);
  // Exercise the production loader with harmless phase bodies. The loader must
  // validate every phase before any installer-side effect can begin.
  for (const name of installerModuleNames) {
    await writeFile(path.join(moduleDirectory, name), `printf '%s\\n' '${name}' >>"$TEST_TRACE"\n`);
  }
  return { root, repo, moduleDirectory, entry, trace: path.join(root, 'trace') };
}

function runInstaller(fixture) {
  return execFile('bash', [fixture.entry], {
    cwd: fixture.root,
    env: { ...process.env, TEST_TRACE: fixture.trace, REPO_DIR: '/untrusted', INSTALLER_DIR: '/untrusted' },
    timeout: 10_000,
    maxBuffer: 32 * 1024,
  });
}

test('installer validates and sources exactly its fixed module inventory in order', async (t) => {
  const inventory = /readonly -a INSTALLER_MODULES=\(\n([\s\S]*?)\n\)/u.exec(installerEntry);
  assert.ok(inventory);
  assert.deepEqual(inventory[1].trim().split(/\s+/u), installerModuleNames);
  const files = await readdir(new URL('../../deploy/systemd/installer/', import.meta.url));
  assert.deepEqual(files.sort(), [...installerModuleNames].sort());
  const fixtureState = await fixture(t);
  await runInstaller(fixtureState);
  assert.deepEqual((await readFile(fixtureState.trace, 'utf8')).trim().split('\n'), installerModuleNames);
});

test('missing, symlinked, or invalid late modules fail before any phase executes', async (t) => {
  for (const failure of ['missing', 'symlink', 'syntax']) {
    const fixtureState = await fixture(t);
    const last = path.join(fixtureState.moduleDirectory, installerModuleNames.at(-1));
    if (failure === 'syntax') await writeFile(last, 'if then\n');
    else {
      await rm(last);
      if (failure === 'symlink') {
        const external = path.join(fixtureState.root, 'external.sh');
        await writeFile(external, 'exit 0\n');
        await symlink(external, last);
      }
    }
    await assert.rejects(runInstaller(fixtureState));
    await assert.rejects(lstat(fixtureState.trace), (error) => error.code === 'ENOENT');
  }
});

test('a failed sourced phase retains errexit and cannot advance to later phases', async (t) => {
  const fixtureState = await fixture(t);
  const first = path.join(fixtureState.moduleDirectory, installerModuleNames[0]);
  await writeFile(first, `printf '%s\\n' '${installerModuleNames[0]}' >>"$TEST_TRACE"\nfalse\n`);
  await assert.rejects(runInstaller(fixtureState), (error) => error.code === 1);
  assert.equal((await readFile(fixtureState.trace, 'utf8')).trim(), installerModuleNames[0]);
});
