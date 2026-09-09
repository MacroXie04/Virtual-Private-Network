import assert from 'node:assert/strict';
import { lstat, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayController } from '../../src/control/authority/controller.js';
import { ControllerSessions } from '../../src/control/authority/sessions.js';
import { createAdminScryptRecord } from '../../src/core/identity/credentials.js';
import { RevisionRepository } from '../../src/state/repository.js';

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

class FakeRuntime {
  constructor() {
    this.restarts = 0;
    this.probes = 0;
    this.failNextProbe = false;
  }

  async restart() {
    this.restarts += 1;
  }

  async probe() {
    this.probes += 1;
    if (this.failNextProbe) {
      this.failNextProbe = false;
      throw new Error('simulated data-path failure');
    }
    return true;
  }
}

export async function fixture({
  authKey = null,
  apiKey = null,
  readExitDirectoryCredential = null,
} = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vpn-controller-'));
  const admin = await createAdminScryptRecord('correct horse battery staple', {
    randomBytesImpl: () => Buffer.alloc(16, 7),
  });
  const state = {
    schemaVersion: 3,
    revision: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    gateway: {
      vpnPublicHostname: 'vpn.example.com',
      subscriptionPublicBaseUrl: 'https://subscriptions.example.com',
      adminPublicHostname: 'admin.example.com',
      websocketPath: `/${'A'.repeat(43)}`,
    },
    tailscale: {
      hostname: 'proxy-vps',
      stateDirectory: path.join(dataDir, 'tailscale'),
      authKey,
      apiKey,
      exitNode: '100.64.0.10',
    },
    health: {
      listenPort: 19080,
      username: 'vpn-health',
      password: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      target: { host: 'health.example.net', port: 443 },
    },
    admin: { scrypt: admin },
    users: [],
  };
  const repository = new RevisionRepository(dataDir);
  await repository.initialize(state, { operation: 'initialize' });
  const runtime = new FakeRuntime();
  let uuidIndex = 0;
  let tokenIndex = 0;
  const sessions = new ControllerSessions({
    randomBytes: (length) => Buffer.alloc(length, ++tokenIndex),
  });
  const controller = new GatewayController({
    repository,
    runtime,
    sessions,
    validateConfig: async () => {},
    readExitDirectoryCredential,
    now: () => new Date(`2026-01-01T00:00:0${Math.min(9, uuidIndex + 1)}.000Z`),
  });
  const lifecycleOptions = {
    // Lifecycle generators use module defaults; deterministic collisions are
    // not required for these behavioral assertions.
    nextUuid: () => UUIDS[uuidIndex++],
  };
  return { controller, repository, runtime, dataDir, lifecycleOptions };
}

export function request(id, op, fields = {}) {
  return { id, op, ...fields };
}

export async function assertMarkerMissing(dataDir) {
  await assert.rejects(lstat(path.join(dataDir, 'maintenance')), (error) => error.code === 'ENOENT');
}
