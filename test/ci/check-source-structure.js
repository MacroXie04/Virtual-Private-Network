import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const MAX_FILE_LINES = 200;
const MAX_DIRECTORY_ENTRIES = 8;
const violations = [];
const summary = { files: 0, directories: 0, maxLines: 0, maxEntries: 0 };

function displayPath(entryPath) {
  return path.join('src', path.relative(sourceRoot, entryPath));
}

function countLines(text) {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\r|\n/u).length;
  return lines - (/[\r\n]$/u.test(text) ? 1 : 0);
}

async function inspectDirectory(directoryPath) {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    violations.push(`${displayPath(directoryPath)}: cannot read directory (${error.code})`);
    return;
  }
  summary.directories += 1;
  summary.maxEntries = Math.max(summary.maxEntries, entries.length);
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    violations.push(
      `${displayPath(directoryPath)}: ${entries.length} entries; limit ${MAX_DIRECTORY_ENTRIES}`,
    );
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await inspectDirectory(entryPath);
    } else if (entry.isFile()) {
      summary.files += 1;
      try {
        const lines = countLines(await readFile(entryPath, 'utf8'));
        summary.maxLines = Math.max(summary.maxLines, lines);
        if (lines > MAX_FILE_LINES) {
          violations.push(`${displayPath(entryPath)}: ${lines} lines; limit ${MAX_FILE_LINES}`);
        }
      } catch (error) {
        violations.push(`${displayPath(entryPath)}: cannot read file (${error.code})`);
      }
    } else {
      violations.push(`${displayPath(entryPath)}: must be a regular file or directory`);
    }
  }
}

await inspectDirectory(sourceRoot);
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Source structure: ${summary.files} files, ${summary.directories} directories; `
    + `largest file ${summary.maxLines}/${MAX_FILE_LINES} lines, `
    + `largest directory ${summary.maxEntries}/${MAX_DIRECTORY_ENTRIES} entries.`,
  );
}
