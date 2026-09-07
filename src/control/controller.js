import path from 'node:path';
import { verifyAdminPassword } from '../core/credentials.js';
import { ControllerSessions } from './controller-sessions.js';
import { fetchExitNodes } from '../runtime/tailscale.js';
import { ControllerError, stringField, revisionField } from './request-contract.js';
import { credentialResult, snapshot } from './state-views.js';
import { setMaintenance, assertOuterTransactionCommitted, appendAudit } from './operational-files.js';
import { recover, retireBootstrapCredentials, transact } from './runtime-transactions.js';
import { recoverIngressMigration } from './ingress-recovery.js';
import { dispatch } from './request-dispatch.js';

function timeoutPromise(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/** Own the serialized authority; domain operations receive this context explicitly. */
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
    readEnrollmentCredential = null,
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
    if (readEnrollmentCredential !== null && typeof readEnrollmentCredential !== 'function') {
      throw new TypeError('readEnrollmentCredential must be a function');
    }
    this.readEnrollmentCredential = readEnrollmentCredential;
    this.now = now;
    this.loginFailureDelayMs = loginFailureDelayMs;
    this.ready = false;
    this.mutationTail = Promise.resolve();
    this.loginTail = Promise.resolve();
    this.maintenancePath = path.join(dataDir, 'maintenance');
    this.outerTransactionPaths = [
      path.join(dataDir, '.legacy-migration-in-progress'),
      path.join(dataDir, '.upgrade-restart-in-progress'),
      path.join(dataDir, '.upgrade-rollback-in-progress'),
    ];
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

  setMaintenance(active) {
    return setMaintenance(this, active);
  }

  assertOuterTransactionCommitted() {
    return assertOuterTransactionCommitted(this);
  }

  appendAudit(event) {
    return appendAudit(this, event);
  }

  recover() {
    return recover(this);
  }

  recoverIngressMigration(previous) {
    return recoverIngressMigration(this, previous);
  }

  retireBootstrapCredentials(current = null) {
    return retireBootstrapCredentials(this, current);
  }

  credentialResult(state, user, token, csrf) {
    return credentialResult(this, state, user, token, csrf);
  }

  snapshot(sessionId) {
    return snapshot(this, sessionId);
  }

  transact(candidateState, options) {
    return transact(this, candidateState, options);
  }

  dispatch(request) {
    return dispatch(this, request);
  }
}
