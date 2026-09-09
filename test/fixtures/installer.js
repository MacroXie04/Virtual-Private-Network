import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const systemdRoot = new URL('../../deploy/systemd/', import.meta.url);
export const installerEntry = await readFile(new URL('install.sh', systemdRoot), 'utf8');
export const installerModuleNames = [...installerEntry.matchAll(
  /^source "\$INSTALLER_DIR\/([a-z-]+\.sh)"$/gmu,
)].map((match) => match[1]);
assert.ok(installerModuleNames.length > 0, 'installer has explicit module sources');
assert.equal(new Set(installerModuleNames).size, installerModuleNames.length, 'installer sources each module once');

const sources = [{ name: 'install.sh', text: installerEntry }];
for (const name of installerModuleNames) {
  sources.push({ name, text: await readFile(new URL(`installer/${name}`, systemdRoot), 'utf8') });
}

export function installerModule(name) {
  const source = sources.find((entry) => entry.name === (name.endsWith('.sh') ? name : `${name}.sh`));
  assert.ok(source, `installer module ${name} exists`);
  return source.text;
}

export function installerFunction(name) {
  const marker = `\n${name}() {\n`;
  const matches = sources.filter((source) => source.text.includes(marker));
  assert.equal(matches.length, 1, `installer function ${name} has one owner`);
  const source = matches[0].text;
  const start = source.indexOf(marker);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `installer function ${name} is complete in its module`);
  return source.slice(start + 1, end + 2);
}

export function assertInstallerMatches(pattern, message) {
  assert.ok(sources.some((source) => pattern.test(source.text)), message ?? `installer module matches ${pattern}`);
}

export function assertInstallerExcludes(pattern, message) {
  for (const source of sources) assert.doesNotMatch(source.text, pattern, message ?? source.name);
}

// Compare execution order across the entry's explicit sources without joining
// independent files into a synthetic installer. Local function/body checks use
// installerFunction or installerModule so they cannot cross a source boundary.
export function installerPosition(fragment, after = 0) {
  let offset = 0;
  for (const source of sources) {
    const index = source.text.indexOf(fragment, Math.max(0, after - offset));
    if (index !== -1 && index + offset >= after) return index + offset;
    offset += source.text.length + 1;
  }
  return -1;
}

export function installerLastPosition(fragment) {
  let result = -1;
  let offset = 0;
  for (const source of sources) {
    const index = source.text.lastIndexOf(fragment);
    if (index !== -1) result = offset + index;
    offset += source.text.length + 1;
  }
  return result;
}
