import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { bootstrap } from '../../src/state/bootstrap-service.js';
import { temporary, orphanedMigrationFixture } from '../fixtures/legacy-migration.js';

test('bootstrap recovers one exact marker-bound migrate-v1 orphan before either pointer', async () => {
  await temporary(async (parent) => {
    const fixture = await orphanedMigrationFixture(parent, { apiFromFile: true });
    const result = await bootstrap({
      env: fixture.env,
      migrationMode: 'apply',
      validateConfigImpl: async () => {},
      randomBytesImpl: () => { throw new Error('orphan recovery must not mint new state'); },
    });
    assert.equal(result.status, 'recovered');
    assert.equal(result.revision, 1);
    const current = await fixture.repository.readCurrent();
    const runtime = await fixture.repository.readRuntime();
    assert.equal(current.id, result.id);
    assert.equal(runtime.id, result.id);
    assert.equal(current.manifest.operation, 'migrate-v1');
    assert.equal(current.state.tailscale.apiKey, 'tskey-api-protected-file-only');
    assert.equal((await fixture.repository.listRevisions()).length, 1);
    assert.equal((await readdir(path.join(fixture.dataDir, 'legacy-backups'))).length, 1);
  });
});

test('marker-bound orphan recovery rejects multiple, unrelated, and tampered revisions', async (t) => {
  await t.test('multiple and unrelated revisions', async () => {
    await temporary(async (parent) => {
      const fixture = await orphanedMigrationFixture(parent);
      const [approved] = await fixture.repository.listRevisions();
      const approvedRevision = await fixture.repository.readRevision(approved.id);
      const unboundEnvironment = { ...fixture.env };
      delete unboundEnvironment.MIGRATION_MARKER_DIR;
      await assert.rejects(bootstrap({
        env: unboundEnvironment,
        migrationMode: 'apply',
        validateConfigImpl: async () => {},
      }), (error) => error.code === 'ORPHANED_REVISION');

      const unrelatedState = structuredClone(approvedRevision.state);
      unrelatedState.revision = 2;
      unrelatedState.updatedAt = '2026-09-04T03:00:01.000Z';
      const unrelated = await fixture.repository.createRevision(unrelatedState, { operation: 'user.update' });

      await assert.rejects(bootstrap({
        env: fixture.env,
        migrationMode: 'apply',
        validateConfigImpl: async () => {},
      }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');

      assert.equal(await fixture.repository.removeRevision(approved.id), true);
      assert.deepEqual((await fixture.repository.listRevisions()).map(({ id }) => id), [unrelated.id]);
      await assert.rejects(bootstrap({
        env: fixture.env,
        migrationMode: 'apply',
        validateConfigImpl: async () => {},
      }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');
    });
  });

  await t.test('tampered revision', async () => {
    await temporary(async (parent) => {
      const fixture = await orphanedMigrationFixture(parent);
      const [approved] = await fixture.repository.listRevisions();
      const statePath = path.join(approved.path, 'state.json');
      const stateBytes = await readFile(statePath);
      await writeFile(statePath, Buffer.concat([stateBytes, Buffer.from(' ')]));
      await assert.rejects(bootstrap({
        env: fixture.env,
        migrationMode: 'apply',
        validateConfigImpl: async () => {},
      }), (error) => error.code === 'REVISION_TAMPERED');
    });
  });
});
