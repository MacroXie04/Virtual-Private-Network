import { pathToFileURL } from 'node:url';
import { createAdminServer } from './admin-application.js';
import { installGracefulShutdown } from './http-service.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = createAdminServer();
    service.listen().then(() => installGracefulShutdown(service)).catch(() => { process.exitCode = 1; });
  } catch {
    process.exitCode = 1;
  }
}
