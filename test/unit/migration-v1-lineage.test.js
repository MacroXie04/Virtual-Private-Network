import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { bootstrap } from '../../src/state/bootstrap-service.js';
import { GatewayController } from '../../src/control/controller.js';
import { assertLegacyV1MigrationLineage } from '../../src/migrations/migration-lineage.js';
import { migrateLegacyV1 } from '../../src/migrations/migrate-v1.js';
import { RevisionRepository } from '../../src/state/repository.js';
import { temporary, targetEnvironment, writeLegacy } from '../fixtures/legacy-migration.js';

test('bare migration resume accepts only the initial v1 lineage or its controller credential scrub', async () => {
  await temporary(async (parent) => {
    const { envPath, configPath } = await writeLegacy(parent, { TS_API_KEY: undefined });
    const dataDir = path.join(parent, 'new-data');
    const stateDirectory = path.join(dataDir, 'tailscale');
    const lineagePath = path.join(parent, 'lineage.json');
    const websocketPath = `/${'A'.repeat(43)}`;
    const apiKeyPath = path.join(parent, 'tailscale-api-key');
    await mkdir(dataDir);
    await writeFile(apiKeyPath, 'tskey-api-lineage-file-only\n', { mode: 0o600 });
    await chmod(apiKeyPath, 0o600);
    const migrationEnvironment = targetEnvironment({
      MIGRATION_STATE_DIR: stateDirectory,
      TS_API_KEY_FILE: apiKeyPath,
      WS_PATH: websocketPath,
    });
    const lineageEnvironment = targetEnvironment({
      TS_API_KEY_FILE: apiKeyPath,
      WS_PATH: websocketPath,
    });
    const repository = new RevisionRepository(dataDir);
    let randomByte = 0;
    await migrateLegacyV1({
      apply: true,
      dataDir,
      envPath,
      configPath,
      env: migrationEnvironment,
      repository,
      validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, ++randomByte),
      now: '2026-09-04T02:00:00.000Z',
    });

    const initial = await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      repository,
    });
    assert.equal(initial.status, 'migrate-v1');
    assert.equal(initial.revision, 1);

    const initialRevision = await repository.readCurrent();
    const scrubState = (updatedAt) => ({
      ...structuredClone(initialRevision.state),
      revision: 2,
      updatedAt,
      tailscale: {
        ...initialRevision.state.tailscale,
        authKey: null,
        apiKey: null,
      },
    });

    // Hard crash after candidate creation, before the runtime pointer switch.
    const createdOnly = await repository.createRevision(
      scrubState('2026-09-04T02:00:01.000Z'),
      { operation: 'credentials.scrub' },
    );
    await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    });
    assert.equal(await repository.readRevision(createdOnly.id).then(() => true, () => false), false);

    // Hard crash after runtime activation, before current activation. Bootstrap
    // restores runtime to current; lineage recovery then retires the unproven
    // scrub candidate so the controller can rerun its routed transaction.
    const runtimeOnly = await repository.createRevision(
      scrubState('2026-09-04T02:00:02.000Z'),
      { operation: 'credentials.scrub' },
    );
    await repository.activateRuntime(runtimeOnly.id);
    const pointerRecovery = await bootstrap({ env: { DATA_DIR: dataDir }, repository });
    assert.equal(pointerRecovery.status, 'recovered');
    assert.equal((await repository.readRuntime()).id, initial.id);
    await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    });
    assert.equal(await repository.readRevision(runtimeOnly.id).then(() => true, () => false), false);

    // Hard crash after current activation, before credential-history cleanup.
    const currentScrub = await repository.createRevision(
      scrubState('2026-09-04T02:00:03.000Z'),
      { operation: 'credentials.scrub' },
    );
    await repository.activateRuntime(currentScrub.id);
    await repository.activateCurrent(currentScrub.id);
    const currentBoundary = await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    });
    assert.equal(currentBoundary.status, 'credentials.scrub');
    assert.equal((await repository.listRevisions()).length, 2);

    const runtime = {
      async restart() {},
      async probe() { return true; },
    };
    const controller = new GatewayController({
      repository,
      runtime,
      validateConfig: async () => {},
      dataDir,
      now: () => new Date('2026-09-04T02:00:04.000Z'),
    });
    const ready = await controller.recover();
    assert.equal(controller.ready, true);
    assert.equal(ready.manifest.operation, 'credentials.scrub');
    assert.equal((await repository.listRevisions()).length, 1);

    await assert.rejects(assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      repository,
    }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');

    // This is the installer resume point after service readiness but before
    // the outer migration marker was durably committed.
    const resumed = await assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    });
    assert.equal(resumed.status, 'credentials.scrub');
    assert.equal(resumed.revision, 2);
    assert.equal(resumed.initialRevisionId, initial.id);

    const scrubbed = await repository.readCurrent();
    const forgedState = structuredClone(scrubbed.state);
    forgedState.gateway.vpnPublicHostname = 'unrelated.example.com';
    const forged = await repository.createRevision(forgedState, { operation: 'credentials.scrub' });
    await repository.activateRuntime(forged.id);
    await repository.activateCurrent(forged.id);
    await assert.rejects(assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');

    const unrelatedState = structuredClone(scrubbed.state);
    unrelatedState.revision = 3;
    unrelatedState.updatedAt = '2026-09-04T02:00:02.000Z';
    const unrelated = await repository.createRevision(unrelatedState, { operation: 'user.update' });
    await repository.activateRuntime(unrelated.id);
    await repository.activateCurrent(unrelated.id);
    await assert.rejects(assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    }), (error) => error.code === 'INVALID_MIGRATION_LINEAGE');

    await repository.activateRuntime(scrubbed.id);
    await repository.activateCurrent(scrubbed.id);
    await writeFile(path.join(scrubbed.path, 'state.json'), `${JSON.stringify(scrubbed.state)}\n `);
    await assert.rejects(assertLegacyV1MigrationLineage({
      dataDir,
      envPath,
      configPath,
      fallbackEnvironment: lineageEnvironment,
      expectedStateDirectory: stateDirectory,
      lineagePath,
      statePublished: true,
      repository,
    }), (error) => error.code === 'REVISION_TAMPERED');
  });
});
