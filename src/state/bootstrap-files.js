import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { ValidationError, validateAbsoluteStatePath } from '../core/validation.js';
import { BootstrapError } from './bootstrap-errors.js';

const NOFOLLOW = fsConstants.O_NOFOLLOW;
const DIRECTORY = fsConstants.O_DIRECTORY;
const SECRET_FILE_MAX_BYTES = 1024;

export function isMissing(error) {
  return error?.code === 'ENOENT';
}

export function absolutePath(value, name) {
  const validated = validateAbsoluteStatePath(value, name);
  if (path.normalize(validated) !== validated) {
    throw new ValidationError(name, 'must be normalized');
  }
  return validated;
}

export async function safeLstat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function readBoundedFileNoFollow(filePath, {
  maxBytes = SECRET_FILE_MAX_BYTES,
  requirePrivate = false,
  description = 'file',
} = {}) {
  const normalizedPath = absolutePath(filePath, `${description}Path`);
  let handle;
  try {
    handle = await open(normalizedPath, fsConstants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) {
      throw new BootstrapError('UNSAFE_FILE', `${description} must be a bounded regular file`);
    }
    if (requirePrivate && ((stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid())) {
      throw new BootstrapError(
        'UNSAFE_PERMISSIONS',
        `${description} must be owned by the current service identity and not accessible by group or other users`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > maxBytes) {
      throw new BootstrapError('UNSAFE_FILE', `${description} changed while being read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof BootstrapError || error instanceof ValidationError) throw error;
    if (isMissing(error)) throw new BootstrapError('FILE_NOT_FOUND', `${description} is missing`);
    throw new BootstrapError('UNSAFE_FILE', `${description} could not be read safely`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readSecretFile(filePath, options = {}) {
  const bytes = await readBoundedFileNoFollow(filePath, {
    ...options,
    maxBytes: options.maxBytes ?? SECRET_FILE_MAX_BYTES,
    requirePrivate: true,
    description: options.description ?? 'secret file',
  });
  let value = bytes.toString('utf8');
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.length < (options.minLength ?? 8)
    || value.length > (options.maxLength ?? 512)
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new BootstrapError('INVALID_SECRET', `${options.description ?? 'secret file'} has invalid content`);
  }
  return value;
}

export async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writePrivateFileExclusive(filePath, bytes) {
  const normalizedPath = absolutePath(filePath, 'privateFilePath');
  let handle;
  try {
    handle = await open(
      normalizedPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new BootstrapError('FILE_EXISTS', 'private bootstrap file already exists');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  await syncDirectory(path.dirname(normalizedPath));
}
