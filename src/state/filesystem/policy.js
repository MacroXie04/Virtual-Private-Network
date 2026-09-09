import { constants as fsConstants } from 'node:fs';

export const ROOT_MODE = 0o751;
export const REVISION_DIRECTORY_MODE = 0o751;
export const STAGING_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const RUNTIME_FILE_MODE = 0o640;
export const SUBSCRIPTION_FILE_MODE = 0o640;
export const NOFOLLOW = fsConstants.O_NOFOLLOW;
export const DIRECTORY = fsConstants.O_DIRECTORY;
export const SERVICE_UID = process.geteuid?.() ?? process.getuid?.() ?? 0;
const SERVICE_GID = process.getegid?.() ?? process.getgid?.() ?? 0;
// A root controller may deliberately expose its control socket to vpn-admin,
// but all private repository objects must remain root:root. Non-root test and
// development processes retain their own primary identity.
export const PRIVATE_GID = SERVICE_UID === 0 ? 0 : SERVICE_GID;
export const REVISION_ID = /^[0-9]{16}-[0-9a-f]{16}$/u;
export const STAGING_ID = /^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const REMOVAL_ID = /^\.remove-[0-9]{16}-[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const POINTER_NAMES = new Set(['current', 'runtime']);
export const REVISION_FILES = Object.freeze([
  'manifest.json',
  'sing-box.json',
  'state.json',
  'subscription-view.json',
]);
export const DEFAULT_MAX_REVISIONS = 32;
export const DEFAULT_MAX_REVISION_BYTES = 64 * 1024 * 1024;
export const STAGING_STALE_MS = 10 * 60 * 1000;

export class RepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
  }
}
