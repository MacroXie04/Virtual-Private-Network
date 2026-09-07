import { pathToFileURL } from 'node:url';
import { createControllerApplication } from './application.js';

async function main() {
  const app = await createControllerApplication();
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void app.close(0).finally(() => { process.exitCode = app.exitCode; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await app.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('VPN gateway controller failed to start.\n');
    process.exitCode = 1;
  });
}
