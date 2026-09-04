import { pathToFileURL } from 'node:url';
import { createControlClient } from './control-client.js';

export async function checkHealth(options = {}) {
  const control = createControlClient({ timeoutMs: 9_000, ...options });
  const result = await control.health();
  if (result?.status !== 'ok' || !Number.isSafeInteger(result.revision) || result.revision < 0) {
    throw new Error('gateway is not ready');
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkHealth().then(
    () => { process.exitCode = 0; },
    () => { process.exitCode = 1; },
  );
}
