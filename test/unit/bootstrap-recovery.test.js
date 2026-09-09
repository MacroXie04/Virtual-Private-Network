import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { bootstrap } from '../../src/state/bootstrap/service.js';
import { RevisionRepository } from '../../src/state/repository.js';
import { temporary, privateFile, environment } from '../fixtures/bootstrap.js';

test('initialized bootstrap is idempotent without rereading settings or rotating secrets', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const secretPath = path.join(env.DATA_DIR, 'admin-secret');
    const before = await readFile(secretPath);

    const result = await bootstrap({
      env: { DATA_DIR: env.DATA_DIR, VPN_PUBLIC_HOSTNAME: 'not a host / and should be ignored' },
      execFileImpl: async () => { throw new Error('must not execute'); },
      validateConfigImpl: async () => { throw new Error('must not validate'); },
      randomBytesImpl: () => { throw new Error('must not rotate credentials'); },
    });
    assert.equal(result.status, 'existing');
    assert.equal(result.revision, 1);
    assert.deepEqual(await readFile(secretPath), before);
  });
});

test('bootstrap refuses to mint a second authority over unpointed committed revisions', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      randomBytesImpl: (size) => Buffer.alloc(size, 7),
      now: '2026-09-04T01:00:00.000Z',
    });
    const revisionsPath = path.join(env.DATA_DIR, 'revisions');
    const before = (await readdir(revisionsPath)).filter((name) => /^\d{16}-[0-9a-f]{16}$/u.test(name));
    await unlink(path.join(env.DATA_DIR, 'current'));
    await unlink(path.join(env.DATA_DIR, 'runtime'));
    await unlink(env.TS_AUTH_KEY_FILE);

    await assert.rejects(bootstrap({
      env: { DATA_DIR: env.DATA_DIR },
      validateConfigImpl: async () => { throw new Error('must not validate'); },
      randomBytesImpl: () => { throw new Error('must not generate credentials'); },
    }), (error) => error.code === 'ORPHANED_REVISION');
    const after = (await readdir(revisionsPath)).filter((name) => /^\d{16}-[0-9a-f]{16}$/u.test(name));
    assert.deepEqual(after, before);
  });
});

test('exclusive startup removes authenticated staging and config-check crash orphans', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const rawOrphan = path.join(
      env.DATA_DIR,
      '.bootstrap-config-11111111-1111-4111-8111-111111111111.json',
    );
    await writeFile(rawOrphan, '{"auth_key":"tskey-auth-orphan"}\n', { mode: 0o600 });
    await chmod(rawOrphan, 0o600);
    const stage = path.join(
      env.DATA_DIR,
      'revisions',
      '.stage-22222222-2222-4222-8222-222222222222',
    );
    await mkdir(stage, { mode: 0o700 });
    await writeFile(path.join(stage, 'sing-box.json'), '{"auth_key":"tskey-auth-stage"}\n', {
      mode: 0o640,
    });

    const result = await bootstrap({ env: { DATA_DIR: env.DATA_DIR } });
    assert.equal(result.status, 'existing');
    await assert.rejects(lstat(rawOrphan), (error) => error.code === 'ENOENT');
    await assert.rejects(lstat(stage), (error) => error.code === 'ENOENT');
  });
});

test('startup refuses an unsafe config-check orphan without following it', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const target = path.join(parent, 'must-remain');
    const orphan = path.join(
      env.DATA_DIR,
      '.bootstrap-config-33333333-3333-4333-8333-333333333333.json',
    );
    await privateFile(target, 'do-not-delete');
    await symlink(target, orphan);

    await assert.rejects(
      bootstrap({ env: { DATA_DIR: env.DATA_DIR } }),
      (error) => error.code === 'UNSAFE_FILE',
    );
    assert.equal((await lstat(orphan)).isSymbolicLink(), true);
    assert.equal((await readFile(target, 'utf8')).trim(), 'do-not-delete');
  });
});

test('bootstrap recovers a missing current pointer without rereading secrets', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    await unlink(path.join(env.DATA_DIR, 'current'));
    const recovered = await bootstrap({ env: { DATA_DIR: env.DATA_DIR } });
    const repository = new RevisionRepository(env.DATA_DIR);
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.revision, 1);
    assert.equal(await repository.readPointer('current'), await repository.readPointer('runtime'));
  });
});

test('bootstrap restores current authority after an interrupted runtime-pointer transaction', async () => {
  await temporary(async (parent) => {
    const env = environment(parent);
    await privateFile(env.TS_AUTH_KEY_FILE, 'tskey-auth-bootstrap-test');
    await privateFile(env.TS_API_KEY_FILE, 'tskey-api-bootstrap-test');
    await bootstrap({
      env,
      validateConfigImpl: async () => {},
      now: '2026-09-04T01:00:00.000Z',
    });
    const repository = new RevisionRepository(env.DATA_DIR);
    const authoritative = await repository.readCurrent();
    const candidate = await repository.createRevision({
      ...authoritative.state,
      revision: authoritative.state.revision + 1,
      updatedAt: '2026-09-04T01:01:00.000Z',
      gateway: {
        ...authoritative.state.gateway,
        subscriptionPublicBaseUrl: 'https://uncommitted.example',
      },
    }, { operation: 'test.interrupted' });
    await repository.activateRuntime(candidate.id);

    const recovered = await bootstrap({ env: { DATA_DIR: env.DATA_DIR } });
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.id, authoritative.id);
    assert.equal(await repository.readPointer('current'), authoritative.id);
    assert.equal(await repository.readPointer('runtime'), authoritative.id);
  });
});
