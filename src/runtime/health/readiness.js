import { probeSocksConnect } from './socks-probe.js';
import { probeWebSocketUpgrade } from './websocket-probe.js';

const delay = (milliseconds) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

export async function waitForDataPath(health, {
  probe = probeSocksConnect,
  websocketProbe = probeWebSocketUpgrade,
  timeoutMs = 30000,
  attemptTimeoutMs = 3000,
  intervalMs = 250,
  now = Date.now,
  wait = delay,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastError;
  do {
    try {
      await websocketProbe({
        connectHost: health.websocket.connectHost,
        connectPort: health.websocket.connectPort,
        authority: health.websocket.authority,
        path: health.websocket.path,
        timeoutMs: Math.min(attemptTimeoutMs, Math.max(1, deadline - now())),
      });
      // Probe all published exits with separate authenticated SOCKS identities.
      // Parallel attempts share the same deadline, so adding exits does not
      // multiply the controller's bounded transaction or watchdog timeout.
      const profiles = health.profiles ?? [{ username: health.username, password: health.password }];
      if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 16) {
        throw new Error('invalid health profiles');
      }
      const results = await Promise.allSettled(profiles.map((profile) => probe({
        proxyHost: health.listenHost ?? '127.0.0.1',
        proxyPort: health.listenPort,
        username: profile.username,
        password: profile.password,
        targetHost: health.targetHost,
        targetPort: health.targetPort,
        timeoutMs: Math.min(attemptTimeoutMs, Math.max(1, deadline - now())),
      })));
      if (results.some((result) => result.status === 'rejected')) throw new Error('an exit is unavailable');
      return true;
    } catch (error) {
      lastError = error;
      if (now() >= deadline) break;
      await wait(Math.min(intervalMs, Math.max(1, deadline - now())));
    }
  } while (now() < deadline);
  throw new Error(`sing-box data path did not become ready${lastError ? '' : ' in time'}`);
}
