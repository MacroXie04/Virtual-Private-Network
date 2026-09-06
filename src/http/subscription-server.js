import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderClientSubscription } from '../core/render.js';
import {
  MAX_USERS,
  validateSubscriptionView as validateCanonicalSubscriptionView,
} from '../core/state-schema.js';
import {
  validatePublicDnsHostname,
} from '../core/validation.js';
import {
  FixedWindowRateLimiter,
  createHttpService,
  installGracefulShutdown,
  parseOriginForm,
  requestAddress,
  sendGenericError,
  sendResponse,
} from './http-common.js';

const MAX_PROJECTION_BYTES = 1024 * 1024;
const TOKEN_ROUTE = /^\/s\/([A-Za-z0-9_-]{32,256})(?:\/(links|sing-box|clash))?$/u;

/** Strictly validate the public, credential-minimized subscription projection. */
export function parseSubscriptionView(value) {
  try {
    if (!Array.isArray(value?.users) || value.users.length > MAX_USERS) throw new Error('invalid projection');
    return validateCanonicalSubscriptionView(value);
  } catch {
    throw new Error('invalid projection');
  }
}

function singleHeader(req, name) {
  let count = 0;
  let value;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) {
      count += 1;
      value = req.rawHeaders[index + 1];
    }
  }
  return count === 1 ? value : null;
}

function hasCanonicalSubscriptionHost(req, view) {
  const raw = singleHeader(req, 'host');
  if (raw === null) return false;
  try {
    return validatePublicDnsHostname(raw, 'Host') === view.gateway.subscriptionPublicHostname;
  } catch {
    return false;
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

function renderSubscription(view, user, format) {
  if (format === 'links') {
    return {
      body: renderClientSubscription(view, user.id, 'links'),
      type: 'text/plain; charset=utf-8',
      filename: 'vless-links.txt',
    };
  }
  if (format === 'sing-box') {
    return {
      body: renderClientSubscription(view, user.id, 'sing-box'),
      type: 'application/json; charset=utf-8',
      filename: 'sing-box.json',
    };
  }
  if (format === 'clash') {
    return {
      body: renderClientSubscription(view, user.id, 'clash'),
      type: 'application/yaml; charset=utf-8',
      filename: 'clash.yaml',
    };
  }
  return {
    body: renderClientSubscription(view, user.id, 'mixed'),
    type: 'text/plain; charset=utf-8',
    filename: null,
  };
}

function sendMaintenanceResponse(req, res) {
  sendResponse(req, res, 503, 'Service Unavailable\n', {
    'content-type': 'text/plain; charset=utf-8',
    'retry-after': '1',
  });
}

/**
 * Public HTTP process API. It reads the projection anew for every accepted
 * request and exposes no controller or administrative routes.
 */
export function createSubscriptionServer({
  dataDir = process.env.DATA_DIR ?? '/var/lib/vpn-gateway',
  projectionPath = path.join(dataDir, 'current', 'subscription-view.json'),
  maintenancePath = path.join(dataDir, 'maintenance'),
  host = process.env.SUB_HOST ?? '127.0.0.1',
  port = Number(process.env.SUB_PORT ?? 8080),
  // Valid credentials have independent buckets, so one subscriber cannot
  // exhaust every other subscriber's allowance behind a shared reverse proxy.
  rateLimiter = new FixedWindowRateLimiter({ limit: 120, windowMs: 60_000, maxEntries: 2048 }),
  invalidTokenRateLimiter = new FixedWindowRateLimiter({ limit: 120, windowMs: 60_000, maxEntries: 2048 }),
  globalRateLimiter = new FixedWindowRateLimiter({ limit: 6_000, windowMs: 60_000, maxEntries: 2048 }),
  loadView = () => readSubscriptionView(projectionPath),
  checkMaintenance = () => isMaintenanceActive(maintenancePath),
  ...httpOptions
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid subscription port');
  if (host !== '127.0.0.1') throw new TypeError('subscription service must bind to IPv4 loopback');
  // This aggregate bucket is deliberately limited to malformed requests.
  // Reverse proxies collapse socket addresses; untrusted traffic must not be
  // able to spend a verified subscriber's independent credential allowance.
  const allowMalformed = (req, res) => {
    const rate = globalRateLimiter.take(requestAddress(req));
    if (rate.allowed) return true;
    sendResponse(req, res, 429, 'Too Many Requests\n', {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': String(rate.retryAfter),
    });
    return false;
  };
  const handler = async (req, res) => {
    let url;
    try {
      url = parseOriginForm(req.url);
    } catch {
      if (!allowMalformed(req, res)) return;
      sendGenericError(req, res, 404);
      return;
    }
    if ((req.method !== 'GET' && req.method !== 'HEAD') || url.search !== '') {
      if (!allowMalformed(req, res)) return;
      sendGenericError(req, res, 404);
      return;
    }
    const route = TOKEN_ROUTE.exec(url.pathname);
    if (!route) {
      if (!allowMalformed(req, res)) return;
      sendGenericError(req, res, 404);
      return;
    }

    if (await checkMaintenance()) {
      sendMaintenanceResponse(req, res);
      return;
    }

    let view;
    try {
      view = await loadView();
    } catch {
      sendGenericError(req, res, 503);
      return;
    }
    // A transaction can enter maintenance and switch the current revision
    // while this request is loading the projection. Recheck after the read so
    // a newly published credential view is never served before its data plane
    // has passed the routed readiness probe.
    if (await checkMaintenance()) {
      sendMaintenanceResponse(req, res);
      return;
    }
    if (!hasCanonicalSubscriptionHost(req, view)) {
      if (!allowMalformed(req, res)) return;
      sendGenericError(req, res, 404);
      return;
    }
    const user = findSubscriptionUser(view, route[1]);
    if (!user) {
      // Guesses share a source bucket and never allocate entries in the valid
      // tenant limiter. This prevents an attacker from filling its bounded
      // table and forcing an unrelated subscriber into the overflow bucket.
      const invalidRate = invalidTokenRateLimiter.take(requestAddress(req));
      if (!invalidRate.allowed) {
        sendResponse(req, res, 429, 'Too Many Requests\n', {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': String(invalidRate.retryAfter),
        });
        return;
      }
      sendGenericError(req, res, 404);
      return;
    }

    // Store only a verified token's one-way digest as its tenant key. The
    // socket address is intentionally not that key because a reverse proxy
    // collapses all clients onto one local peer and forwarded headers are
    // outside this service's trust boundary.
    const credentialRateKey = createHash('sha256').update(route[1], 'utf8').digest('hex');
    const credentialRate = rateLimiter.take(credentialRateKey);
    if (!credentialRate.allowed) {
      sendResponse(req, res, 429, 'Too Many Requests\n', {
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': String(credentialRate.retryAfter),
      });
      return;
    }

    const rendered = renderSubscription(view, user, route[2] ?? 'mixed');
    const headers = { 'content-type': rendered.type };
    if (rendered.filename) headers['content-disposition'] = `attachment; filename="${rendered.filename}"`;
    sendResponse(req, res, 200, rendered.body, headers);
  };

  return createHttpService(handler, { host, port, ...httpOptions });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = createSubscriptionServer();
    service.listen().then(() => installGracefulShutdown(service)).catch(() => { process.exitCode = 1; });
  } catch {
    process.exitCode = 1;
  }
}
