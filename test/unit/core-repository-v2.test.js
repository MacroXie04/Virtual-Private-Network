import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RevisionRepository } from '../../src/repository.js';
import { fixtureState } from './core-v2-fixture.js';

async function inTemporaryRepository(run) {
  const parent = await mkdtemp(path.join(tmpdir(), 'vpn-core-v2-'));
  const root = path.join(parent, 'data');
  try {
    await run({ parent, root, repository: new RevisionRepository(root) });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function mode(stat) {
  return stat.mode & 0o777;
}

test('repository creates immutable, hashed revisions with least-privilege modes', async () => {
  await inTemporaryRepository(async ({ root, repository }) => {
    const created = await repository.createRevision(fixtureState(), { operation: 'bootstrap' });
    const privateGid = (process.geteuid?.() ?? process.getuid?.() ?? 0) === 0
      ? 0
      : process.getegid?.() ?? process.getgid?.() ?? 0;
    assert.match(created.id, /^0{15}1-[0-9a-f]{16}$/u);
    assert.equal(mode(await lstat(root)), 0o751);
    assert.equal((await lstat(root)).gid, privateGid);
    assert.equal(mode(await lstat(path.join(root, 'revisions'))), 0o751);
    assert.equal((await lstat(path.join(root, 'revisions'))).gid, privateGid);
    assert.equal(mode(await lstat(created.path)), 0o751);
    assert.equal((await lstat(created.path)).gid, privateGid);
    assert.equal(mode(await lstat(path.join(created.path, 'state.json'))), 0o600);
    assert.equal((await lstat(path.join(created.path, 'state.json'))).gid, privateGid);
    assert.equal(mode(await lstat(path.join(created.path, 'manifest.json'))), 0o600);
    assert.equal((await lstat(path.join(created.path, 'manifest.json'))).gid, privateGid);
    assert.equal(mode(await lstat(path.join(created.path, 'sing-box.json'))), 0o640);
    assert.equal(mode(await lstat(path.join(created.path, 'subscription-view.json'))), 0o640);

    const manifest = JSON.parse(await readFile(path.join(created.path, 'manifest.json'), 'utf8'));
    for (const name of ['state.json', 'sing-box.json', 'subscription-view.json']) {
      const bytes = await readFile(path.join(created.path, name));
      assert.equal(manifest.files[name].size, bytes.length);
      assert.equal(manifest.files[name].sha256, createHash('sha256').update(bytes).digest('hex'));
    }
    await assert.rejects(
      repository.createRevision(fixtureState(), { operation: 'bootstrap' }),
      (error) => error.code === 'REVISION_EXISTS',
    );
  });
});

test('root repository fixes private ownership while assigning only projection groups', {
  skip: (process.geteuid?.() ?? process.getuid?.() ?? -1) !== 0,
}, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'vpn-core-v2-root-groups-'));
  const root = path.join(parent, 'data');
  try {
    const repository = new RevisionRepository(root, {
      runtimeGid: 11000,
      subscriptionGid: 11001,
    });
    const created = await repository.createRevision(fixtureState(), { operation: 'bootstrap' });
    assert.equal((await lstat(created.path)).gid, 0);
    assert.equal((await lstat(path.join(created.path, 'state.json'))).gid, 0);
    assert.equal((await lstat(path.join(created.path, 'manifest.json'))).gid, 0);
    assert.equal((await lstat(path.join(created.path, 'sing-box.json'))).gid, 11000);
    assert.equal((await lstat(path.join(created.path, 'subscription-view.json'))).gid, 11001);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('current and runtime pointers switch atomically and independently', async () => {
  await inTemporaryRepository(async ({ root, repository }) => {
    const first = await repository.initialize(fixtureState(), { operation: 'bootstrap' });
    assert.equal(await readlink(path.join(root, 'current')), `revisions/${first.id}`);
    assert.equal(await readlink(path.join(root, 'runtime')), `revisions/${first.id}`);
    assert.equal((await repository.readCurrent()).state.revision, 1);

    const secondState = fixtureState({
      revision: 2,
      updatedAt: '2026-09-04T00:01:00.000Z',
    });
    const second = await repository.createRevision(secondState, { operation: 'user.create' });
    await repository.activateRuntime(second.id);
    assert.equal(await repository.readPointer('runtime'), second.id);
    assert.equal(await repository.readPointer('current'), first.id);
    await repository.activateCurrent(second.id);
    assert.equal((await repository.readCurrentState()).revision, 2);
    assert.equal((await repository.readCurrentSubscriptionView()).revision, 2);
  });
});

test('initialization completes either safe one-pointer crash state', async () => {
  await inTemporaryRepository(async ({ root, repository }) => {
    const revision = await repository.createRevision(fixtureState(), { operation: 'bootstrap' });
    await repository.activateRuntime(revision.id);
    const recovered = await repository.initialize(fixtureState({
      reality: {
        ...fixtureState().reality,
        privateKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
        publicKey: 'zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk',
      },
    }), { operation: 'bootstrap' });
    assert.equal(recovered.id, revision.id);
    assert.equal(await repository.readPointer('current'), revision.id);

    await unlink(path.join(root, 'runtime'));
    const recoveredAgain = await repository.initialize(fixtureState(), { operation: 'bootstrap' });
    assert.equal(recoveredAgain.id, revision.id);
    assert.equal(await repository.readPointer('runtime'), revision.id);
  });
});

test('manifest verification detects a changed revision file', async () => {
  await inTemporaryRepository(async ({ repository }) => {
    const created = await repository.createRevision(fixtureState());
    const changed = fixtureState({ gateway: { ...fixtureState().gateway, advertisedPort: 444 } });
    await writeFile(path.join(created.path, 'state.json'), `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(
      repository.readRevision(created.id),
      (error) => error.code === 'REVISION_TAMPERED',
    );
  });
});

test('repository refuses symlink roots, symlink revision files, and non-symlink pointers', async () => {
  await inTemporaryRepository(async ({ parent, root, repository }) => {
    const target = path.join(parent, 'target');
    await mkdir(target);
    await symlink(target, root, 'dir');
    await assert.rejects(repository.ensure(), (error) => error.code === 'UNSAFE_PATH');
  });

  await inTemporaryRepository(async ({ root, repository }) => {
    const created = await repository.createRevision(fixtureState());
    await writeFile(path.join(root, 'current'), 'not a symlink');
    await assert.rejects(
      repository.activateCurrent(created.id),
      (error) => error.code === 'UNSAFE_POINTER',
    );

    const projectionPath = path.join(created.path, 'subscription-view.json');
    await rm(projectionPath);
    await symlink('state.json', projectionPath);
    await assert.rejects(
      repository.readRevision(created.id),
      (error) => error.code === 'INVALID_REVISION',
    );
  });
});

test('repository bounds immutable history while preserving current and runtime revisions', async () => {
  await inTemporaryRepository(async ({ repository: ignored, root }) => {
    const repository = new RevisionRepository(root, { maxRevisions: 3 });
    await repository.initialize(fixtureState(), { operation: 'bootstrap' });
    for (let revision = 2; revision <= 7; revision += 1) {
      const created = await repository.createRevision(fixtureState({
        revision,
        updatedAt: `2026-09-04T00:0${revision}:00.000Z`,
      }), { operation: 'user.update' });
      await repository.activateRuntime(created.id);
      await repository.activateCurrent(created.id);
    }
    const records = await repository.listRevisions();
    assert.equal(records.length, 3);
    assert.ok(records.reduce((sum, record) => sum + record.bytes, 0) <= repository.maxRevisionBytes);
    assert.equal((await repository.readCurrent()).state.revision, 7);
    assert.equal((await repository.readRuntime()).state.revision, 7);
  });
});

test('retention never deletes divergent protected pointers and fails safely on an unsafe old revision', async () => {
  await inTemporaryRepository(async ({ repository: ignored, root }) => {
    const repository = new RevisionRepository(root, { maxRevisions: 2 });
    const first = await repository.initialize(fixtureState(), { operation: 'bootstrap' });
    const second = await repository.createRevision(fixtureState({
      revision: 2,
      updatedAt: '2026-09-04T00:02:00.000Z',
    }), { operation: 'user.update' });
    await repository.activateRuntime(second.id);
    await assert.rejects(repository.createRevision(fixtureState({
      revision: 3,
      updatedAt: '2026-09-04T00:03:00.000Z',
    })), (error) => error.code === 'REVISION_QUOTA');
    assert.equal(await repository.readPointer('current'), first.id);
    assert.equal(await repository.readPointer('runtime'), second.id);
  });

  await inTemporaryRepository(async ({ repository: ignored, root }) => {
    const repository = new RevisionRepository(root, { maxRevisions: 2 });
    const first = await repository.initialize(fixtureState(), { operation: 'bootstrap' });
    const orphan = await repository.createRevision(fixtureState({
      revision: 2,
      updatedAt: '2026-09-04T00:02:00.000Z',
    }), { operation: 'user.update' });
    await writeFile(path.join(orphan.path, 'unexpected'), 'unsafe');
    await assert.rejects(repository.createRevision(fixtureState({
      revision: 3,
      updatedAt: '2026-09-04T00:03:00.000Z',
    })), (error) => error.code === 'INVALID_REVISION');
    assert.equal(await repository.readPointer('current'), first.id);
    assert.equal(await repository.readPointer('runtime'), first.id);
    assert.equal((await repository.readCurrent()).state.revision, 1);
  });
});

test('repository recovery removes only safely shaped interrupted staging revisions', async () => {
  await inTemporaryRepository(async ({ root, repository }) => {
    await repository.ensure();
    const stale = path.join(root, 'revisions', '.stage-11111111-1111-4111-8111-111111111111');
    await mkdir(stale, { mode: 0o700 });
    await writeFile(path.join(stale, 'state.json'), '{}\n', { mode: 0o600 });
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(stale, old, old);
    await repository.ensure();
    await assert.rejects(lstat(stale), (error) => error.code === 'ENOENT');

    const active = path.join(root, 'revisions', '.stage-33333333-3333-4333-8333-333333333333');
    await mkdir(active, { mode: 0o700 });
    await writeFile(path.join(active, 'state.json'), '{}\n', { mode: 0o600 });
    await repository.ensure();
    assert.equal((await lstat(active)).isDirectory(), true);

    const unsafe = path.join(root, 'revisions', '.stage-22222222-2222-4222-8222-222222222222');
    await mkdir(unsafe, { mode: 0o700 });
    await writeFile(path.join(unsafe, 'unexpected'), 'do not delete');
    await assert.rejects(repository.ensure(), (error) => error.code === 'UNSAFE_PATH');
    assert.equal((await lstat(path.join(unsafe, 'unexpected'))).isFile(), true);
  });
});

test('revision deletion is crash-safe and recovery finishes a partial quarantined delete', async () => {
  await inTemporaryRepository(async ({ root, repository }) => {
    const current = await repository.initialize(fixtureState(), { operation: 'bootstrap' });
    const obsolete = await repository.createRevision(fixtureState({
      revision: 2,
      updatedAt: '2026-09-04T00:02:00.000Z',
    }), { operation: 'credentials.scrub' });
    const tombstone = path.join(
      root,
      'revisions',
      `.remove-${obsolete.id}-11111111-1111-4111-8111-111111111111`,
    );

    // Model a process dying after the atomic quarantine and after only one of
    // the four files was removed. The visible revision namespace remains whole.
    await rename(obsolete.path, tombstone);
    await unlink(path.join(tombstone, 'state.json'));

    await repository.ensure();
    await assert.rejects(lstat(tombstone), (error) => error.code === 'ENOENT');
    assert.equal((await repository.readCurrent()).id, current.id);
    assert.deepEqual((await repository.listRevisions()).map(({ id }) => id), [current.id]);
  });
});
