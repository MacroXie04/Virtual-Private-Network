import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RevisionRepository } from '../../src/state/repository.js';
import { fixtureState } from '../fixtures/state.js';

/** Rewrite a stored artifact the way an older release would have written it, keeping the manifest honest. */
async function rewriteArtifact(revisionPath, name, mutate) {
  const artifactPath = path.join(revisionPath, name);
  const manifestPath = path.join(revisionPath, 'manifest.json');
  const value = JSON.parse(await readFile(artifactPath, 'utf8'));
  mutate(value);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(artifactPath, bytes);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('revisions written before usage accounting load without the stats block', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vpn-revision-compat-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = new RevisionRepository(dataDir);
  await repository.initialize(fixtureState(), { operation: 'initialize' });
  const current = await repository.readCurrent();
  assert.equal(current.config.experimental.v2ray_api.stats.enabled, true);

  await rewriteArtifact(current.path, 'sing-box.json', (config) => { delete config.experimental; });
  const legacy = await repository.readCurrent();
  assert.equal(legacy.id, current.id);
  assert.equal(Object.hasOwn(legacy.config, 'experimental'), false);
  assert.deepEqual(legacy.state, current.state);

  // Any tampering with the block itself is still refused.
  await rewriteArtifact(current.path, 'sing-box.json', (config) => {
    config.experimental = { v2ray_api: { listen: '0.0.0.0:19081', stats: { enabled: true, users: ['alice'] } } };
  });
  await assert.rejects(repository.readCurrent(), (error) => error.code === 'INVALID_REVISION');
});
