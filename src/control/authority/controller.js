import path from 'node:path';
import { verifyAdminPassword } from '../../core/identity/credentials.js';
import { ControllerSessions } from './sessions.js';
import { adminLogin, createAccountSessions } from './accounts.js';
import { fetchExitNodes } from '../../runtime/tailscale.js';
import { ControllerError, stringField, revisionField } from '../requests/contract.js';
import { snapshot } from './state-views.js';
import { setMaintenance, assertOuterTransactionCommitted, appendAudit } from './operational-files.js';
import { recover, retireBootstrapCredentials, transact } from './runtime-transactions.js';
import { dispatch } from '../requests/dispatch.js';

/** Own the serialized authority; domain operations receive this context explicitly. */
export class GatewayController {
  constructor({
    repository,
    runtime,
    validateConfig,
    dataDir = repository?.root,
    sessions = new ControllerSessions(),
    accountSessions = createAccountSessions(),
    verifyPassword = verifyAdminPassword,
    exitDirectory = fetchExitNodes,
    readExitDirectoryCredential = null,
    readEnrollmentCredential = null,
    usage = null,
    now = () => new Date(),
    loginFailureDelayMs = 150,
    setLoginTimeout = setTimeout,
  }) {
    if (!repository || !runtime || typeof validateConfig !== 'function') {
      throw new TypeError('repository, runtime, and validateConfig are required');
    }
    this.repository = repository;
    this.runtime = runtime;
    this.validateConfig = validateConfig;
    this.dataDir = dataDir;
    this.sessions = sessions;
    this.accountSessions = accountSessions;
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
    if (usage !== null && typeof usage?.sample !== 'function') throw new TypeError('usage must be a tracker');
    this.usage = usage;
    this.now = now;
    this.loginFailureDelayMs = loginFailureDelayMs;
    this.setLoginTimeout = setLoginTimeout;
    this.accountBudget = new Map();
    this.ready = false;
    this.mutationTail = Promise.resolve();
    this.loginTail = Promise.resolve();
    this.maintenancePath = path.join(dataDir, 'maintenance');
    this.outerTransactionPaths = [
      // An unfinished retired transaction is unsupported, never resumed here.
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

  /** Fold the current sing-box counters into persisted usage; never throws. */
  async sampleUsage() {
    if (!this.usage) return false;
    try {
      return await this.usage.sample();
    } catch {
      return false;
    }
  }

  collectUsage() {
    return this.queueMutation(() => this.sampleUsage());
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

  login(secret) {
    return adminLogin(this, secret);
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

  retireBootstrapCredentials(current = null) {
    return retireBootstrapCredentials(this, current);
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
