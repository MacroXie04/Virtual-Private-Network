import crypto from 'node:crypto';

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function equalDigest(left, right) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class ControllerSessions {
  constructor({
    now = Date.now,
    randomBytes = crypto.randomBytes,
    idleTimeoutMs = 30 * 60 * 1000,
    absoluteTimeoutMs = 8 * 60 * 60 * 1000,
    maxSessions = 64,
    replayTimeoutMs = 5 * 60 * 1000,
    maxReplayEntries = 4,
  } = {}) {
    if (typeof now !== 'function' || typeof randomBytes !== 'function') {
      throw new TypeError('session clock and random source must be functions');
    }
    for (const [name, value] of [
      ['idleTimeoutMs', idleTimeoutMs],
      ['absoluteTimeoutMs', absoluteTimeoutMs],
      ['replayTimeoutMs', replayTimeoutMs],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 30 * 24 * 60 * 60 * 1000) {
        throw new TypeError(`${name} is invalid`);
      }
    }
    for (const [name, value, maximum] of [
      ['maxSessions', maxSessions, 1024],
      ['maxReplayEntries', maxReplayEntries, 32],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new TypeError(`${name} is invalid`);
      }
    }
    this.now = now;
    this.randomBytes = randomBytes;
    this.idleTimeoutMs = idleTimeoutMs;
    this.absoluteTimeoutMs = absoluteTimeoutMs;
    this.maxSessions = maxSessions;
    this.replayTimeoutMs = replayTimeoutMs;
    this.maxReplayEntries = maxReplayEntries;
    this.sessions = new Map();
  }

  prune() {
    const current = this.now();
    for (const [key, session] of this.sessions) {
      if (session.absoluteExpiresAt <= current || session.idleExpiresAt <= current) {
        this.sessions.delete(key);
      }
    }
  }

  issue(credentialVersion = 1) {
    this.prune();
    while (this.sessions.size >= this.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
    const sessionId = this.randomBytes(32).toString('base64url');
    const csrf = this.randomBytes(32).toString('base64url');
    const current = this.now();
    this.sessions.set(digest(sessionId), {
      csrf,
      csrfDigest: digest(csrf),
      credentialVersion,
      absoluteExpiresAt: current + this.absoluteTimeoutMs,
      idleExpiresAt: current + this.idleTimeoutMs,
      replays: new Map(),
    });
    return {
      sessionId,
      csrf,
      expiresAt: new Date(current + this.absoluteTimeoutMs).toISOString(),
    };
  }

  get(sessionId, credentialVersion = 1) {
    this.prune();
    if (typeof sessionId !== 'string' || sessionId.length > 128) return null;
    const key = digest(sessionId);
    const session = this.sessions.get(key);
    if (!session || session.credentialVersion !== credentialVersion) return null;
    session.idleExpiresAt = Math.min(
      this.now() + this.idleTimeoutMs,
      session.absoluteExpiresAt,
    );
    this.sessions.delete(key);
    this.sessions.set(key, session);
    return { key, session };
  }

  currentCsrf(sessionId, credentialVersion = 1) {
    const found = this.get(sessionId, credentialVersion);
    return found?.session.csrf ?? null;
  }

  verifyMutation(sessionId, csrf, credentialVersion = 1) {
    const found = this.get(sessionId, credentialVersion);
    if (!found || typeof csrf !== 'string' || csrf.length > 128) return null;
    if (!equalDigest(found.session.csrfDigest, digest(csrf))) return null;

    return { key: found.key, session: found.session };
  }

  rotateMutation(verified) {
    if (
      !verified
      || typeof verified.key !== 'string'
      || this.sessions.get(verified.key) !== verified.session
    ) return null;
    const nextCsrf = this.randomBytes(32).toString('base64url');
    verified.session.csrf = nextCsrf;
    verified.session.csrfDigest = digest(nextCsrf);
    return { key: verified.key, session: verified.session, csrf: nextCsrf };
  }

  lookupReplay(sessionId, requestId, fingerprint, credentialVersion = 1) {
    const found = this.get(sessionId, credentialVersion);
    if (!found
      || typeof requestId !== 'string'
      || !/^[A-Za-z0-9-]{1,64}$/u.test(requestId)
      || typeof fingerprint !== 'string') return { status: 'miss' };
    const current = this.now();
    for (const [key, entry] of found.session.replays) {
      if (entry.expiresAt <= current) found.session.replays.delete(key);
    }
    const entry = found.session.replays.get(requestId);
    if (!entry) return { status: 'miss' };
    if (!equalDigest(entry.fingerprintDigest, digest(fingerprint))) {
      return { status: 'conflict' };
    }
    return { status: 'match', result: structuredClone(entry.result) };
  }

  rememberReplay(verified, requestId, fingerprint, result) {
    if (
      !verified
      || typeof verified.key !== 'string'
      || this.sessions.get(verified.key) !== verified.session
      || typeof requestId !== 'string'
      || !/^[A-Za-z0-9-]{1,64}$/u.test(requestId)
      || typeof fingerprint !== 'string'
    ) return false;
    const replays = verified.session.replays;
    while (replays.size >= this.maxReplayEntries) replays.delete(replays.keys().next().value);
    replays.set(requestId, {
      fingerprintDigest: digest(fingerprint),
      expiresAt: Math.min(this.now() + this.replayTimeoutMs, verified.session.absoluteExpiresAt),
      result: structuredClone(result),
    });
    return true;
  }

  forgetReplay(sessionId, requestId, credentialVersion = 1) {
    const found = this.get(sessionId, credentialVersion);
    if (!found || typeof requestId !== 'string') return false;
    return found.session.replays.delete(requestId);
  }

  clearReplays() {
    for (const session of this.sessions.values()) session.replays.clear();
  }

  destroy(sessionId) {
    if (typeof sessionId !== 'string') return false;
    return this.sessions.delete(digest(sessionId));
  }

  destroyAll() {
    this.sessions.clear();
  }
}
