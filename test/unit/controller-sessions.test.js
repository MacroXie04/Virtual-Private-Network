import assert from 'node:assert/strict';
import test from 'node:test';
import { ControllerSessions } from '../../src/controller-sessions.js';

function deterministicRandom() {
  let value = 0;
  return (length) => Buffer.alloc(length, ++value);
}

test('controller sessions verify CSRF without rotation and rotate only on commit', () => {
  const sessions = new ControllerSessions({ randomBytes: deterministicRandom() });
  const issued = sessions.issue(3);
  assert.ok(sessions.get(issued.sessionId, 3));
  assert.equal(sessions.get(issued.sessionId, 2), null);
  const refreshed = sessions.currentCsrf(issued.sessionId, 3);
  assert.equal(refreshed, issued.csrf);
  assert.equal(sessions.verifyMutation(issued.sessionId, 'wrong', 3), null);

  const verified = sessions.verifyMutation(issued.sessionId, refreshed, 3);
  assert.ok(verified);
  assert.equal(sessions.currentCsrf(issued.sessionId, 3), issued.csrf);
  const mutated = sessions.rotateMutation(verified);
  assert.ok(mutated.csrf);
  assert.equal(sessions.verifyMutation(issued.sessionId, issued.csrf, 3), null);
  const verifiedAgain = sessions.verifyMutation(issued.sessionId, mutated.csrf, 3);
  assert.ok(verifiedAgain);
  assert.equal(sessions.currentCsrf(issued.sessionId, 3), mutated.csrf);
});

test('controller sessions enforce idle and absolute expiry', () => {
  let current = 0;
  const sessions = new ControllerSessions({
    now: () => current,
    randomBytes: deterministicRandom(),
    idleTimeoutMs: 10,
    absoluteTimeoutMs: 25,
  });
  const first = sessions.issue();
  current = 9;
  assert.ok(sessions.get(first.sessionId));
  current = 20;
  assert.equal(sessions.get(first.sessionId), null);

  const second = sessions.issue();
  current = 29;
  assert.ok(sessions.get(second.sessionId));
  current = 38;
  assert.ok(sessions.get(second.sessionId));
  current = 44;
  assert.ok(sessions.get(second.sessionId));
  current = 46;
  assert.equal(sessions.get(second.sessionId), null);
});

test('one-time results have bounded, exact, in-memory replay semantics', () => {
  let current = 0;
  const sessions = new ControllerSessions({
    now: () => current,
    randomBytes: deterministicRandom(),
    replayTimeoutMs: 10,
    maxReplayEntries: 1,
  });
  const issued = sessions.issue();
  const verified = sessions.verifyMutation(issued.sessionId, issued.csrf);
  const result = { rawToken: 'secret-once', csrf: 'next' };
  assert.equal(sessions.rememberReplay(verified, 'request-one', 'exact-fields', result), true);
  result.rawToken = 'changed-by-caller';
  assert.deepEqual(
    sessions.lookupReplay(issued.sessionId, 'request-one', 'exact-fields'),
    { status: 'match', result: { rawToken: 'secret-once', csrf: 'next' } },
  );
  assert.deepEqual(
    sessions.lookupReplay(issued.sessionId, 'request-one', 'different-fields'),
    { status: 'conflict' },
  );
  assert.equal(
    sessions.rememberReplay(verified, 'request-two', 'other-fields', { rawToken: 'second' }),
    true,
  );
  assert.deepEqual(
    sessions.lookupReplay(issued.sessionId, 'request-one', 'exact-fields'),
    { status: 'miss' },
  );
  current = 11;
  assert.deepEqual(
    sessions.lookupReplay(issued.sessionId, 'request-two', 'other-fields'),
    { status: 'miss' },
  );
});

test('a replay can be forgotten without affecting the session', () => {
  const sessions = new ControllerSessions({ randomBytes: deterministicRandom() });
  const issued = sessions.issue();
  const verified = sessions.verifyMutation(issued.sessionId, issued.csrf);
  sessions.rememberReplay(verified, 'request-one', 'exact-fields', { rawToken: 'secret' });
  assert.equal(sessions.forgetReplay(issued.sessionId, 'request-one'), true);
  assert.deepEqual(
    sessions.lookupReplay(issued.sessionId, 'request-one', 'exact-fields'),
    { status: 'miss' },
  );
  assert.equal(sessions.currentCsrf(issued.sessionId), issued.csrf);
});
