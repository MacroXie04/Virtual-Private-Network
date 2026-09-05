import { writeFile } from 'node:fs/promises';
import { fixtureState } from '../unit/core-v2-fixture.js';

const outputPath = process.argv[2];
if (!outputPath) throw new TypeError('an output path is required');

await writeFile(outputPath, `${JSON.stringify(fixtureState(), null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
