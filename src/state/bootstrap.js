import { pathToFileURL } from 'node:url';
import { bootstrap } from './bootstrap-service.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap().then((result) => {
    const verb = result.status === 'existing'
      ? 'Using'
      : result.status === 'recovered'
        ? 'Recovered'
        : result.status === 'migration-staged'
          ? 'Staged migration for'
          : result.status === 'migration-dry-run'
            ? 'Validated migration from'
          : 'Initialized';
    process.stdout.write(`${verb} VPN gateway state revision ${result.revision}.\n`);
  }).catch((error) => {
    process.stderr.write(`VPN gateway bootstrap failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
