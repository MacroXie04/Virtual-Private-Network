import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { MAX_USERS } from '../core/state-schema.js';
import { validateSubscriptionView as validateCanonicalSubscriptionView } from '../core/subscription-view.js';

const MAX_PROJECTION_BYTES = 1024 * 1024;

/** Strictly validate the public, credential-minimized subscription projection. */
export function parseSubscriptionView(value) {
  try {
    if (!Array.isArray(value?.users) || value.users.length > MAX_USERS) throw new Error('invalid projection');
    return validateCanonicalSubscriptionView(value);
  } catch {
    throw new Error('invalid projection');
  }
}

export async function readSubscriptionView(projectionPath, { maxBytes = MAX_PROJECTION_BYTES } = {}) {
  let handle;
  try {
    handle = await open(projectionPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > maxBytes) {
      throw new Error('invalid projection');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > maxBytes) throw new Error('invalid projection');
    return parseSubscriptionView(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error('subscription data unavailable');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function isMaintenanceActive(markerPath) {
  try {
    await lstat(markerPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return true;
  }
}

export function findSubscriptionUser(view, rawToken) {
  const candidate = Buffer.from(`sha256:${createHash('sha256').update(rawToken, 'utf8').digest('hex')}`);
  let match = null;
  for (const user of view.users) {
    const expected = Buffer.from(user.tokenHash);
    const equal = expected.length === candidate.length && timingSafeEqual(expected, candidate);
    if (equal) match = user;
  }
  return match;
}
