import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

import { waitForDataPath } from '../health/readiness.js';

export class SystemdSingBoxRuntime {
  constructor({
    health,
    unit = 'vpn-gateway-sing-box.service',
    systemctlPath = '/usr/bin/systemctl',
    execFile = execFileAsync,
    probe = waitForDataPath,
  }) {
    this.health = health;
    this.unit = unit;
    this.systemctlPath = systemctlPath;
    this.execFile = execFile;
    this.probeImpl = probe;
  }

  async restart() {
    try {
      // The unit permits up to 30 seconds for an old process to stop. Keep the
      // client alive beyond that ceiling: terminating systemctl does not cancel
      // the manager job and an overlapping rollback could otherwise race it.
      await this.execFile(this.systemctlPath, ['--no-ask-password', 'restart', this.unit], {
        timeout: 45000,
        maxBuffer: 32 * 1024,
        encoding: 'utf8',
      });
    } catch {
      throw new Error('sing-box restart failed');
    }
  }

  async probe(options = {}) {
    try {
      await this.execFile(this.systemctlPath, ['is-active', '--quiet', this.unit], {
        timeout: 5000,
        maxBuffer: 4096,
      });
    } catch {
      throw new Error('sing-box is not active');
    }
    return this.probeImpl(this.health, options);
  }

  isRunning() {
    return null;
  }
}
