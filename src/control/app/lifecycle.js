import { randomUUID } from 'node:crypto';

/** Probe routed readiness and make publication fail closed on every failure. */
export async function runDataPathWatchdog(authority) {
  try {
    await authority.dispatch({ id: `watchdog-${randomUUID()}`, op: 'health.status' });
    return true;
  } catch {
    authority.markUnready();
    try {
      await authority.setMaintenance(true);
    } catch {
      throw new Error('data-path watchdog could not publish maintenance state');
    }
    return false;
  }
}

export function createApplicationLifecycle({
  authority,
  runtimeAdapter,
  control,
  supervise,
  notifyReady,
  startWeb,
  watchdogIntervalMs,
  setWatchdogTimeout,
  clearWatchdogTimeout,
}) {
  let web = null;
  let stopping = false;
  let exitCode = 0;
  let startPromise = null;
  let cleanupPromise = null;
  let closePromise = null;
  let watchdogTimer = null;
  let watchdogPromise = Promise.resolve();

  const scheduleWatchdog = () => {
    if (stopping || watchdogTimer !== null) return;
    watchdogTimer = setWatchdogTimeout(() => {
      watchdogTimer = null;
      if (stopping) return;
      watchdogPromise = runDataPathWatchdog(authority)
        .catch(() => {
          // If the maintenance marker itself cannot be made authoritative,
          // stopping the full application is the only fail-closed outcome.
          fatal();
        })
        .finally(() => {
          if (!stopping) scheduleWatchdog();
        });
    }, watchdogIntervalMs);
    watchdogTimer?.unref?.();
  };

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (watchdogTimer !== null) {
        clearWatchdogTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      authority.markUnready();
      await control.close().catch(() => { exitCode = 1; });
      await Promise.allSettled([authority.drain?.(), watchdogPromise]);
      // A watchdog recovery that was already queued may have published
      // readiness while shutdown was beginning. Reassert local unready state
      // after all controller mutations have drained.
      authority.markUnready();
      if (typeof authority.setMaintenance === 'function') {
        await authority.setMaintenance(true).catch(() => { exitCode = 1; });
      }
      authority.sessions?.destroyAll?.();
      await web?.stop().catch(() => { exitCode = 1; });
      if (supervise) await runtimeAdapter.stop().catch(() => { exitCode = 1; });
    })();
    return cleanupPromise;
  };
  const close = (code = 0) => {
    exitCode = Math.max(exitCode, code);
    stopping = true;
    authority.markUnready();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      await cleanup();
    })();
    return closePromise;
  };
  const fatal = () => {
    void close(1).finally(() => { process.exitCode = 1; });
  };

  const application = {
    controller: authority,
    runtime: runtimeAdapter,
    control,
    get exitCode() { return exitCode; },
    start() {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        if (stopping) throw new Error('controller startup was interrupted');
        try {
          await authority.recover();
        } catch (error) {
          // Keep the root-owned control socket and loopback administration UI
          // available when the selected exit node cannot establish a routed
          // data path. The maintenance marker remains in place, so public
          // subscriptions stay fail-closed while an administrator selects a
          // different exit node from the freshly validated directory.
          if (error?.code !== 'RUNTIME_UNAVAILABLE') throw error;
        }
        if (stopping) throw new Error('controller startup was interrupted');
        await control.listen();
        if (stopping) throw new Error('controller startup was interrupted');
        if (supervise) {
          web = startWeb(fatal);
          if (stopping) throw new Error('controller startup was interrupted');
        }
        await notifyReady();
        scheduleWatchdog();
      })().catch(async (error) => {
        exitCode = 1;
        stopping = true;
        await cleanup();
        throw error;
      });
      return startPromise;
    },
    close,
  };
  return { application, fatal };
}
