import { constants as fsConstants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  verifyAdminPassword,
  verifySubscriptionToken,
} from './credentials.js';
import { ControllerSessions } from './controller-sessions.js';
import {
  LifecycleError,
  createUser,
  disableUser,
  enableUser,
  getUser,
  revokeUser,
  rotateSubscriptionToken,
  rotateUserCredentials,
} from './lifecycle.js';
import { renderVlessLink } from './render.js';
import { RepositoryError } from './repository.js';
import { validateState } from './state-schema.js';
import { fetchExitNodes, selectExitNode } from './tailscale.js';
import {
  ValidationError,
  normalizeDisplayName,
  validatePublicBaseUrl,
} from './validation.js';

const NOFOLLOW = fsConstants.O_NOFOLLOW;
const MAX_AUDIT_BYTES = 1024 * 1024;
const CONTROLLER_UID = process.geteuid?.() ?? process.getuid?.() ?? 0;
const CONTROLLER_GID = CONTROLLER_UID === 0
  ? 0
  : process.getegid?.() ?? process.getgid?.() ?? 0;

async function normalizePrivateHandle(handle, description) {
  let stat = await handle.stat();
  if (
    !stat.isFile()
    || stat.nlink !== 1
    || stat.uid !== CONTROLLER_UID
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(`unsafe ${description}`);
  }
  if (stat.gid !== CONTROLLER_GID) await handle.chown(CONTROLLER_UID, CONTROLLER_GID);
  stat = await handle.stat();
  if (
    !stat.isFile()
    || stat.nlink !== 1
    || stat.uid !== CONTROLLER_UID
    || stat.gid !== CONTROLLER_GID
    || (stat.mode & 0o777) !== 0o600
  ) throw new Error(`unsafe ${description}`);
  return stat;
}

export class ControllerError extends Error {
  constructor(code, status = 500, message = 'Controller operation failed') {
    super(message);
    this.name = 'ControllerError';
    this.code = code;
    this.status = status;
  }
}

function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControllerError('INVALID', 400);
  }
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new ControllerError('INVALID', 400);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new ControllerError('INVALID', 400);
  }
  return value;
}

function stringField(value, { min = 1, max = 4096, pattern = null } = {}) {
  if (
    typeof value !== 'string'
    || value.length < min
    || value.length > max
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || (pattern && !pattern.test(value))
  ) throw new ControllerError('INVALID', 400);
  return value;
}

function revisionField(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ControllerError('INVALID', 400);
  return value;
}

function credentialMutationFingerprint(request, operation) {
  if (operation === 'user.create') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'displayName']);
    return JSON.stringify([
      operation,
      request.csrf,
      request.expectedRevision,
      request.displayName,
    ]);
  }
  if (operation === 'user.rotateToken' || operation === 'user.rotateCredentials') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId']);
    return JSON.stringify([
      operation,
      request.csrf,
      request.expectedRevision,
      request.userId,
    ]);
  }
  return null;
}

function safeUser(user) {
  return {
    id: user.id,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    disabledAt: user.disabledAt,
    revokedAt: user.revokedAt,
  };
}

function nextState(value, patch, timestamp) {
  const state = validateState(value);
  return validateState({
    ...state,
    ...patch,
    revision: state.revision + 1,
    updatedAt: timestamp,
  });
}

function operationError(error) {
  if (error instanceof ControllerError) return error;
  if (error instanceof LifecycleError) {
    return new ControllerError(error.code, error.status ?? 409);
  }
  if (error instanceof ValidationError) return new ControllerError('INVALID', 400);
  if (error instanceof RepositoryError) return new ControllerError('STATE_UNAVAILABLE', 503);
  return new ControllerError('INTERNAL', 500);
}

function timeoutPromise(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/**
 * Root-side authority. It accepts only typed lifecycle operations and never a
 * path, command, service name, or raw sing-box configuration from its caller.
 */
export class GatewayController {
  constructor({
    repository,
    runtime,
    validateConfig,
    dataDir = repository?.root,
    sessions = new ControllerSessions(),
    verifyPassword = verifyAdminPassword,
    exitDirectory = fetchExitNodes,
    readExitDirectoryCredential = null,
    now = () => new Date(),
    loginFailureDelayMs = 150,
  }) {
    if (!repository || !runtime || typeof validateConfig !== 'function') {
      throw new TypeError('repository, runtime, and validateConfig are required');
    }
    this.repository = repository;
    this.runtime = runtime;
    this.validateConfig = validateConfig;
    this.dataDir = dataDir;
    this.sessions = sessions;
    this.verifyPassword = verifyPassword;
    this.exitDirectory = exitDirectory;
    if (readExitDirectoryCredential !== null && typeof readExitDirectoryCredential !== 'function') {
      throw new TypeError('readExitDirectoryCredential must be a function');
    }
    this.readExitDirectoryCredential = readExitDirectoryCredential;
    this.now = now;
    this.loginFailureDelayMs = loginFailureDelayMs;
    this.ready = false;
    this.mutationTail = Promise.resolve();
    this.loginTail = Promise.resolve();
    this.maintenancePath = path.join(dataDir, 'maintenance');
    this.auditPath = path.join(dataDir, 'audit.jsonl');
  }

  timestamp() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  markUnready() {
    this.ready = false;
  }

  async drain() {
    await Promise.allSettled([this.mutationTail, this.loginTail]);
  }

  async setMaintenance(active) {
    if (!active) {
      await unlink(this.maintenancePath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      return;
    }
    let handle;
    try {
      handle = await open(
        this.maintenancePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
        0o600,
      );
      await normalizePrivateHandle(handle, 'maintenance marker');
      await handle.writeFile(`${this.timestamp()}\n`);
      await handle.sync();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = await open(this.maintenancePath, fsConstants.O_RDONLY | NOFOLLOW);
        await normalizePrivateHandle(existing, 'maintenance marker');
      } finally {
        await existing?.close().catch(() => {});
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async appendAudit({ operation, revision, userId = null, outcome = 'committed' }) {
    const event = Buffer.from(`${JSON.stringify({
      timestamp: this.timestamp(),
      operation,
      revision,
      userId,
      outcome,
    })}\n`, 'utf8');
    const previousPath = `${this.auditPath}.previous`;
    let handle;
    try {
      handle = await open(
        this.auditPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | NOFOLLOW,
        0o600,
      );
      let stat = await normalizePrivateHandle(handle, 'audit path');
      if (stat.size + event.length > MAX_AUDIT_BYTES) {
        await handle.close();
        handle = null;
        const previous = await lstat(previousPath).catch((error) => {
          if (error?.code === 'ENOENT') return null;
          throw error;
        });
        if (previous !== null) {
          if (
            !previous.isFile()
            || previous.isSymbolicLink()
            || previous.nlink !== 1
            || previous.uid !== CONTROLLER_UID
            || previous.gid !== CONTROLLER_GID
            || (previous.mode & 0o777) !== 0o600
          ) {
            throw new Error('unsafe rotated audit path');
          }
          await unlink(previousPath);
        }
        await rename(this.auditPath, previousPath);
        handle = await open(
          this.auditPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
          0o600,
        );
        stat = await normalizePrivateHandle(handle, 'audit path');
      }
      await handle.writeFile(event);
      await handle.sync();
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async recover() {
    let current = await this.repository.readCurrent();
    if (!current) throw new ControllerError('NOT_INITIALIZED', 503);
    if (current.requiresPolicyUpgrade) {
      throw new ControllerError('STATE_UNAVAILABLE', 503);
    }
    this.ready = false;
    await this.setMaintenance(true);
    await this.repository.activateRuntime(current.id);
    try {
      await this.validateConfig(path.join(current.path, 'sing-box.json'));
      await this.runtime.restart();
      await this.runtime.probe();
      return await this.retireBootstrapCredentials(current);
    } catch {
      this.ready = false;
      await this.setMaintenance(true).catch(() => {});
      throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
    }
  }

  /**
   * Publish readiness only after enrollment credentials are absent from the
   * current state/config and every superseded credential-bearing revision has
   * been atomically retired. This is also called after degraded exit repair so
   * that path cannot bypass the same post-enrollment invariant.
   */
  async retireBootstrapCredentials(current = null) {
    let authoritative = current ?? await this.repository.readCurrent();
    if (!authoritative) throw new ControllerError('NOT_INITIALIZED', 503);
    const credentialsPresent = authoritative.state.tailscale.authKey !== null
      || authoritative.state.tailscale.apiKey !== null;
    if (credentialsPresent) {
      const timestamp = this.timestamp();
      const scrubbed = nextState(authoritative.state, {
        tailscale: {
          ...authoritative.state.tailscale,
          authKey: null,
          apiKey: null,
        },
      }, timestamp < authoritative.state.updatedAt ? authoritative.state.updatedAt : timestamp);
      await this.transact(scrubbed, {
        operation: 'credentials.scrub',
        publishReady: false,
      });
      authoritative = await this.repository.readCurrent();
    }

    // If the process stopped after committing the scrub but before deleting
    // its predecessor, the manifest makes cleanup safely retryable. Revision
    // deletion first atomically quarantines a whole directory, so an
    // interruption can never expose a partially deleted normal revision.
    // Scan independently of the current operation label. This both repairs
    // state produced by older releases and prevents a later degraded repair
    // from obscuring an interrupted cleanup behind a new current revision.
    const revisions = await this.repository.listRevisions();
    for (const revision of revisions) {
      if (revision.id === authoritative.id) continue;
      const obsolete = typeof this.repository.readRevisionForRetirement === 'function'
        ? await this.repository.readRevisionForRetirement(revision.id)
        : await this.repository.readRevision(revision.id);
      if (
        obsolete.requiresPolicyUpgrade
        || obsolete.state.tailscale.authKey !== null
        || obsolete.state.tailscale.apiKey !== null
      ) {
        const removed = await this.repository.removeRevision(revision.id);
        if (!removed) throw new Error('credential-bearing revision remained protected');
      }
    }
    await this.setMaintenance(false);
    this.ready = true;
    return authoritative;
  }

  queueMutation(callback) {
    const run = this.mutationTail.then(callback, callback);
    this.mutationTail = run.catch(() => {});
    return run;
  }

  queueLogin(callback) {
    const run = this.loginTail.then(callback, callback);
    this.loginTail = run.catch(() => {});
    return run;
  }

  async state() {
    const current = await this.repository.readCurrent();
    if (!current) throw new ControllerError('NOT_INITIALIZED', 503);
    return current;
  }

  async exitDirectoryCredential(state) {
    if (this.readExitDirectoryCredential === null) return state.tailscale.apiKey;
    const credential = await this.readExitDirectoryCredential();
    return stringField(credential, { min: 8, max: 512 });
  }

  session(sessionId) {
    const found = this.sessions.get(sessionId);
    if (!found) throw new ControllerError('UNAUTHORIZED', 401);
    return found;
  }

  mutationSession(sessionId, csrf) {
    const found = this.sessions.verifyMutation(sessionId, csrf);
    if (!found) throw new ControllerError('FORBIDDEN', 403);
    return found;
  }

  commitMutationSession(verified) {
    const rotated = this.sessions.rotateMutation(verified);
    if (!rotated) throw new ControllerError('UNAUTHORIZED', 401);
    return rotated.csrf;
  }

  assertRevision(current, expectedRevision) {
    if (current.state.revision !== revisionField(expectedRevision)) {
      throw new ControllerError('STALE_REVISION', 409);
    }
  }

  credentialResult(state, user, token, csrf) {
    const base = state.gateway.publicBaseUrl;
    return {
      user: safeUser(user),
      rawToken: token,
      vlessLink: renderVlessLink(state, user.id),
      subscriptionUrl: base ? `${base}/s/${encodeURIComponent(token)}` : null,
      revision: state.revision,
      csrf,
    };
  }

  async transact(candidateState, {
    operation,
    userId = null,
    restart = true,
    publishReady = true,
  }) {
    const previous = await this.state();
    if (candidateState.revision !== previous.state.revision + 1) {
      throw new ControllerError('STALE_REVISION', 409);
    }
    const candidate = await this.repository.createRevision(candidateState, { operation });
    try {
      await this.validateConfig(path.join(candidate.path, 'sing-box.json'));
      await this.setMaintenance(true);
    } catch {
      await this.repository.removeRevision?.(candidate.id).catch(() => {});
      await this.appendAudit({
        operation,
        revision: previous.state.revision,
        userId,
        outcome: 'rejected',
      }).catch(() => {});
      throw new ControllerError('CANDIDATE_REJECTED', 503);
    }
    this.ready = false;
    try {
      await this.repository.activateRuntime(candidate.id);
      if (restart) await this.runtime.restart();
      await this.runtime.probe();
      await this.repository.activateCurrent(candidate.id);
      if (publishReady) {
        await this.setMaintenance(false);
        this.ready = true;
      } else {
        this.ready = false;
      }
      await this.appendAudit({ operation, revision: candidateState.revision, userId }).catch(() => {});
      return candidate;
    } catch {
      let rollbackHealthy = false;
      try {
        await this.repository.activateCurrent(previous.id);
        await this.repository.activateRuntime(previous.id);
        if (restart) await this.runtime.restart();
        await this.runtime.probe();
        rollbackHealthy = true;
      } catch {
        rollbackHealthy = false;
      }
      if (rollbackHealthy && publishReady) {
        try {
          await this.setMaintenance(false);
        } catch {
          rollbackHealthy = false;
        }
      }
      this.ready = rollbackHealthy && publishReady;
      await this.repository.removeRevision?.(candidate.id).catch(() => {});
      await this.appendAudit({
        operation,
        revision: previous.state.revision,
        userId,
        outcome: rollbackHealthy ? 'rolled-back' : 'rollback-failed',
      }).catch(() => {});
      throw new ControllerError(rollbackHealthy ? 'ROLLED_BACK' : 'ROLLBACK_FAILED', 503);
    }
  }

  async login(secret) {
    return this.queueLogin(async () => {
      const current = await this.state();
      const valid = await this.verifyPassword(secret, current.state.admin.scrypt);
      if (!valid) {
        await timeoutPromise(this.loginFailureDelayMs);
        throw new ControllerError('UNAUTHORIZED', 401);
      }
      // Session issuance can evict the oldest bounded session. Serialize that
      // small step with mutations so an authenticated in-flight mutation cannot
      // commit and then lose its session before its post-commit CSRF rotation.
      return this.queueMutation(() => this.sessions.issue());
    });
  }

  async snapshot(sessionId) {
    this.session(sessionId);
    const current = await this.state();
    const liveUsers = current.state.users.filter((user) => user.status !== 'revoked');
    const revokedUsers = current.state.users.filter((user) => user.status === 'revoked');
    const visibleRevoked = revokedUsers.slice(-64);
    let exitNodes = [];
    let exitDirectoryAvailable = false;
    try {
      const credential = await this.exitDirectoryCredential(current.state);
      if (credential) {
        exitNodes = await this.exitDirectory(credential);
        exitDirectoryAvailable = true;
      }
    } catch {
      exitNodes = [];
    }
    const selected = exitNodes.find((node) => (
      node.ipv4 === current.state.tailscale.exitNode
      || node.ipv6 === current.state.tailscale.exitNode
      || node.name === current.state.tailscale.exitNode
    ));
    const csrf = this.sessions.currentCsrf(sessionId);
    if (!csrf) throw new ControllerError('UNAUTHORIZED', 401);
    return {
      revision: current.state.revision,
      csrf,
      ready: this.ready,
      gateway: {
        host: current.state.gateway.host,
        advertisedPort: current.state.gateway.advertisedPort,
        publicBaseUrl: current.state.gateway.publicBaseUrl,
        exitNode: {
          deviceId: selected?.deviceId ?? null,
          address: current.state.tailscale.exitNode,
        },
      },
      exitNodes,
      exitDirectoryAvailable,
      users: [...liveUsers, ...visibleRevoked].map(safeUser),
      revokedOmitted: revokedUsers.length - visibleRevoked.length,
    };
  }

  async dispatch(request) {
    try {
      exactObject(request, ['id', 'op', 'secret', 'sessionId', 'csrf', 'expectedRevision', 'displayName', 'userId', 'status', 'confirmName', 'deviceId', 'url'], ['id', 'op']);
      stringField(request.id, { min: 1, max: 64, pattern: /^[A-Za-z0-9-]+$/u });
      const op = stringField(request.op, { min: 3, max: 32, pattern: /^[a-z][a-zA-Z.]+$/u });

      if (op === 'health.status') {
        exactObject(request, ['id', 'op']);
        return await this.queueMutation(async () => {
          let current = await this.state();
          const runtimeId = await this.repository.readPointer('runtime');
          if (
            !this.ready
            || runtimeId !== current.id
            || current.state.tailscale.authKey !== null
            || current.state.tailscale.apiKey !== null
          ) {
            try {
              current = await this.recover();
            } catch {
              this.ready = false;
              await this.setMaintenance(true).catch(() => {});
              throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
            }
            return { status: 'ok', revision: current.state.revision };
          }
          try {
            await this.runtime.probe({ timeoutMs: 3_000, attemptTimeoutMs: 2_500, intervalMs: 100 });
          } catch {
            this.ready = false;
            await this.setMaintenance(true).catch(() => {});
            throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
          }
          return { status: 'ok', revision: current.state.revision };
        });
      }
      if (op === 'auth.login') {
        exactObject(request, ['id', 'op', 'secret']);
        return await this.login(stringField(request.secret, { min: 1, max: 1024 }));
      }
      if (op === 'auth.check') {
        exactObject(request, ['id', 'op', 'sessionId']);
        this.session(stringField(request.sessionId, { min: 16, max: 512 }));
        return {};
      }
      if (op === 'admin.snapshot') {
        exactObject(request, ['id', 'op', 'sessionId']);
        return await this.snapshot(stringField(request.sessionId, { min: 16, max: 512 }));
      }
      if (op === 'user.export') {
        exactObject(request, ['id', 'op', 'sessionId', 'userId']);
        this.session(stringField(request.sessionId, { min: 16, max: 512 }));
        const current = await this.state();
        const user = getUser(current.state, stringField(request.userId, { min: 3, max: 64 }));
        if (user.status !== 'active') throw new ControllerError('USER_NOT_FOUND', 404);
        return { vlessLink: renderVlessLink(current.state, user.id) };
      }

      return await this.queueMutation(async () => {
        if (op === 'auth.logout') {
          exactObject(request, ['id', 'op', 'sessionId', 'csrf']);
          const sessionId = stringField(request.sessionId, { min: 16, max: 512 });
          this.mutationSession(sessionId, stringField(request.csrf, { min: 1, max: 512 }));
          this.sessions.destroy(sessionId);
          return {};
        }

        const credentialFingerprint = credentialMutationFingerprint(request, op);
        if (credentialFingerprint !== null) {
          const replay = this.sessions.lookupReplay?.(
            stringField(request.sessionId, { min: 16, max: 512 }),
            request.id,
            credentialFingerprint,
          );
          if (replay?.status === 'match') {
            // Another administrator may have committed an unrelated revision
            // between a lost response and its retry. Rebuild the non-secret
            // fields from current authority and return the cached token only
            // while it still authenticates the same active user. This keeps
            // delivery reliable without ever replaying superseded credentials.
            const replayState = await this.state();
            const replayUser = replayState.state.users.find(
              (user) => user.id === replay.result?.user?.id,
            );
            if (
              replayUser?.status === 'active'
              && verifySubscriptionToken(replay.result?.rawToken, replayUser.tokenHash)
            ) {
              const currentCsrf = this.sessions.currentCsrf(request.sessionId);
              if (!currentCsrf) throw new ControllerError('UNAUTHORIZED', 401);
              return this.credentialResult(
                replayState.state,
                replayUser,
                replay.result.rawToken,
                currentCsrf,
              );
            }
            this.sessions.forgetReplay?.(request.sessionId, request.id);
            throw new ControllerError('IDEMPOTENCY_STALE', 409);
          }
          if (replay?.status === 'conflict') {
            throw new ControllerError('IDEMPOTENCY_CONFLICT', 409);
          }
        }

        // A failed persisted exit node must not make the repair interface
        // disappear. In degraded mode every mutation remains blocked except a
        // freshly validated exit-node selection, which itself has to pass the
        // full restart/readiness transaction before maintenance is cleared.
        if (!this.ready && op !== 'exit.select') {
          throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
        }

        const sessionId = stringField(request.sessionId, { min: 16, max: 512 });
        const authorized = this.mutationSession(
          sessionId,
          stringField(request.csrf, { min: 1, max: 512 }),
        );
        const current = await this.state();
        this.assertRevision(current, request.expectedRevision);
        const mutationOptions = { now: this.now };

        if (op === 'user.create') {
          exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'displayName']);
          const changed = createUser(current.state, { displayName: request.displayName }, mutationOptions);
          await this.transact(changed.state, { operation: 'user.create', userId: changed.user.id });
          const nextCsrf = this.commitMutationSession(authorized);
          const result = this.credentialResult(changed.state, changed.user, changed.token, nextCsrf);
          this.sessions.rememberReplay?.(authorized, request.id, credentialFingerprint, result);
          return result;
        }
        if (op === 'user.setStatus') {
          exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId', 'status']);
          const userId = stringField(request.userId, { min: 3, max: 64 });
          const changed = request.status === 'active'
            ? enableUser(current.state, userId, mutationOptions)
            : request.status === 'disabled'
              ? disableUser(current.state, userId, mutationOptions)
              : (() => { throw new ControllerError('INVALID', 400); })();
          await this.transact(changed.state, { operation: `user.${request.status}`, userId });
          return {
            user: safeUser(changed.user),
            revision: changed.state.revision,
            csrf: this.commitMutationSession(authorized),
          };
        }
        if (op === 'user.revoke') {
          exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId', 'confirmName']);
          const userId = stringField(request.userId, { min: 3, max: 64 });
          const user = getUser(current.state, userId);
          if (normalizeDisplayName(request.confirmName, 'confirmName') !== user.displayName) {
            throw new ControllerError('CONFIRMATION_MISMATCH', 400);
          }
          const changed = revokeUser(current.state, userId, mutationOptions);
          await this.transact(changed.state, { operation: 'user.revoke', userId });
          return {
            user: safeUser(changed.user),
            revision: changed.state.revision,
            csrf: this.commitMutationSession(authorized),
          };
        }
        if (op === 'user.rotateToken') {
          exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId']);
          const userId = stringField(request.userId, { min: 3, max: 64 });
          const changed = rotateSubscriptionToken(current.state, userId, mutationOptions);
          await this.transact(changed.state, { operation: 'user.rotate-token', userId, restart: false });
          const nextCsrf = this.commitMutationSession(authorized);
          const result = this.credentialResult(changed.state, changed.user, changed.token, nextCsrf);
          this.sessions.rememberReplay?.(authorized, request.id, credentialFingerprint, result);
          return result;
        }
        if (op === 'user.rotateCredentials') {
          exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'userId']);
          const userId = stringField(request.userId, { min: 3, max: 64 });
          const changed = rotateUserCredentials(current.state, userId, mutationOptions);
          await this.transact(changed.state, { operation: 'user.rotate-all', userId });
          const nextCsrf = this.commitMutationSession(authorized);
          const result = this.credentialResult(changed.state, changed.user, changed.token, nextCsrf);
          this.sessions.rememberReplay?.(authorized, request.id, credentialFingerprint, result);
          return result;
        }
        if (op === 'publicBase.set') {
          exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'url']);
          const url = validatePublicBaseUrl(request.url, 'url');
          const timestamp = this.timestamp();
          const changed = nextState(current.state, {
            gateway: { ...current.state.gateway, publicBaseUrl: url },
          }, timestamp);
          await this.transact(changed, { operation: 'public-base.set', restart: false });
          return { revision: changed.revision, csrf: this.commitMutationSession(authorized) };
        }
        if (op === 'exit.select') {
          exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'deviceId']);
          let directoryCredential;
          try {
            directoryCredential = await this.exitDirectoryCredential(current.state);
          } catch {
            throw new ControllerError('EXIT_DIRECTORY_UNAVAILABLE', 503);
          }
          if (!directoryCredential) throw new ControllerError('EXIT_DIRECTORY_REQUIRED', 409);
          let candidates;
          try {
            candidates = await this.exitDirectory(directoryCredential);
          } catch {
            throw new ControllerError('EXIT_DIRECTORY_UNAVAILABLE', 503);
          }
          let selected;
          try {
            selected = selectExitNode(candidates, stringField(request.deviceId, { min: 1, max: 128 }));
          } catch {
            throw new ControllerError('EXIT_NODE_NOT_AVAILABLE', 409);
          }
          const timestamp = this.timestamp();
          const changed = nextState(current.state, {
            tailscale: { ...current.state.tailscale, exitNode: selected.address },
          }, timestamp);
          await this.transact(changed, {
            operation: 'exit.select',
            // Keep the marker in place through the unconditional history scan;
            // an earlier scrub may have committed before cleanup was
            // interrupted even though this candidate itself has no secrets.
            publishReady: false,
          });
          const committed = await this.retireBootstrapCredentials();
          return {
            revision: committed.state.revision,
            exitNode: selected,
            csrf: this.commitMutationSession(authorized),
          };
        }
        throw new ControllerError('UNKNOWN_OPERATION', 400);
      });
    } catch (error) {
      throw operationError(error);
    }
  }
}
