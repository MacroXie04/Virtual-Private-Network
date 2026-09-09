import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

export async function validateSingBoxConfig(configPath, {
  singBoxPath = '/usr/local/bin/sing-box',
  execFile = execFileAsync,
  timeoutMs = 15000,
} = {}) {
  try {
    await execFile(singBoxPath, ['check', '-c', configPath], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
  } catch {
    throw new Error('sing-box rejected the candidate configuration');
  }
}
