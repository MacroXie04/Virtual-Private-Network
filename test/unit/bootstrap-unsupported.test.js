import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, readlink, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { bootstrap } from '../../src/state/bootstrap/service.js';
import { RevisionRepository } from '../../src/state/repository.js';
import { temporary } from '../fixtures/bootstrap.js';
import { fixtureState } from '../fixtures/state.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function snapshot(directory) {
  const result = {};
  for (const name of (await readdir(directory)).sort()) {
    const entry = path.join(directory, name);
    const stat = await lstat(entry);
    result[name] = { mode: stat.mode, uid: stat.uid, gid: stat.gid, mtimeMs: stat.mtimeMs };
    if (stat.isSymbolicLink()) result[name].target = await readlink(entry);
    else if (stat.isDirectory()) result[name].entries = await snapshot(entry);
    else result[name].sha256 = digest(await readFile(entry));
  }
  return result;
}

async function preserveOnFailure(dataDir, code) {
  const before = await snapshot(path.dirname(dataDir));
  await assert.rejects(bootstrap({
    env: { DATA_DIR: dataDir },
    execFileImpl: () => assert.fail('must not execute'),
    validateConfigImpl: () => assert.fail('must not validate'),
    randomBytesImpl: () => assert.fail('must not generate credentials'),
  }), (error) => error.code === code);
  assert.deepEqual(await snapshot(path.dirname(dataDir)), before);
}

async function addStaleStage(dataDir) {
  const stage = path.join(dataDir, 'revisions', '.stage-11111111-1111-4111-8111-111111111111');
  await mkdir(stage, { mode: 0o700 });
  await writeFile(path.join(stage, 'state.json'), '{}\n', { mode: 0o600 });
  await utimes(stage, new Date(0), new Date(0));
  await chmod(dataDir, 0o700);
}

// Alter only the schema discriminator of a current fixture. This exercises
// refusal without retaining an implementation of an older state format.
async function setUnsupportedSchema(revision, schemaVersion) {
  const statePath = path.join(revision.path, 'state.json');
  const state = JSON.parse(await readFile(statePath));
  const stateBytes = bytes({ ...state, schemaVersion });
  const manifestPath = path.join(revision.path, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.files['state.json'] = { sha256: digest(stateBytes), size: stateBytes.length };
  await writeFile(statePath, stateBytes);
  await writeFile(manifestPath, bytes(manifest));
}

test('unsupported unpointed layouts are refused without reading or changing their files', async (t) => {
  for (const name of ['env', 'config.json', 'tsnet', '.legacy-migration-in-progress']) {
    await t.test(name, () => temporary(async (parent) => {
      const dataDir = path.join(parent, 'data');
      await mkdir(dataDir, { mode: 0o700 });
      if (name === 'tsnet') await mkdir(path.join(dataDir, name));
      else await symlink(path.join(parent, 'missing-source'), path.join(dataDir, name));
      await preserveOnFailure(dataDir, 'UNSUPPORTED_DATA');
    }));
  }
});

test('unfinished conversion marker blocks an otherwise valid v3 repository before cleanup', () => temporary(async (parent) => {
  const dataDir = path.join(parent, 'data');
  const repository = new RevisionRepository(dataDir);
  await repository.initialize(fixtureState());
  await addStaleStage(dataDir);
  await mkdir(path.join(dataDir, '.legacy-migration-in-progress'), { mode: 0o700 });
  await preserveOnFailure(dataDir, 'UNSUPPORTED_DATA');
}));

test('unsupported pointed schemas leave permissions, candidates and pointers unchanged', async (t) => {
  for (const schemaVersion of [1, 2]) {
    for (const placement of ['current', 'runtime-only', 'runtime-candidate']) {
      await t.test(`${schemaVersion}: ${placement}`, () => temporary(async (parent) => {
        const dataDir = path.join(parent, 'data');
        const repository = new RevisionRepository(dataDir);
        let revision = await repository.initialize(fixtureState());
        if (placement === 'runtime-candidate') {
          revision = await repository.createRevision(fixtureState({ revision: 2 }));
          await repository.activateRuntime(revision.id);
        } else if (placement === 'runtime-only') {
          await unlink(path.join(dataDir, 'current'));
        }
        await setUnsupportedSchema(revision, schemaVersion);
        await addStaleStage(dataDir);
        await preserveOnFailure(dataDir, 'UNSUPPORTED_SCHEMA');
      }));
    }
  }
});

test('valid current authority recovers a damaged v3 runtime candidate', async (t) => {
  for (const damage of ['config', 'state', 'manifest']) {
    await t.test(damage, () => temporary(async (parent) => {
      const dataDir = path.join(parent, 'data');
      const repository = new RevisionRepository(dataDir);
      const current = await repository.initialize(fixtureState());
      const candidate = await repository.createRevision(fixtureState({ revision: 2 }));
      await repository.activateRuntime(candidate.id);
      const file = damage === 'config' ? 'sing-box.json' : `${damage}.json`;
      await writeFile(path.join(candidate.path, file), '{invalid JSON');
      const result = await bootstrap({ env: { DATA_DIR: dataDir } });
      assert.equal(result.status, 'recovered');
      assert.equal(await repository.readPointer('current'), current.id);
      assert.equal(await repository.readPointer('runtime'), current.id);
    }));
  }
});

test('committed v3 state remains usable with retained original files', () => temporary(async (parent) => {
  const dataDir = path.join(parent, 'data');
  const repository = new RevisionRepository(dataDir);
  const revision = await repository.initialize(fixtureState(), { operation: 'ingress.migrate' });
  await writeFile(path.join(dataDir, 'env'), 'retained original\n', { mode: 0o600 });
  await writeFile(path.join(dataDir, 'config.json'), 'retained original\n', { mode: 0o600 });
  const result = await bootstrap({ env: { DATA_DIR: dataDir } });
  assert.equal(result.status, 'existing');
  assert.equal(result.id, revision.id);
}));

test('runtime-only uncommitted conversion never becomes current authority', () => temporary(async (parent) => {
  const dataDir = path.join(parent, 'data');
  const repository = new RevisionRepository(dataDir);
  await repository.initialize(fixtureState(), { operation: 'ingress.migrate' });
  await unlink(path.join(dataDir, 'current'));
  await addStaleStage(dataDir);
  await preserveOnFailure(dataDir, 'UNSUPPORTED_DATA');
}));
