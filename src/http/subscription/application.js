import { createHash } from 'node:crypto';
import path from 'node:path';
import { FixedWindowRateLimiter } from '../shared/rate-limit.js';
import { parseOriginForm, requestAddress } from '../shared/input.js';
import { tooManyRequests, createHttpService, sendGenericError, sendResponse } from '../shared/service.js';
import { findSubscriptionUser, isMaintenanceActive, readSubscriptionView } from './data.js';
import { TOKEN_ROUTE, canonicalSharedHostname, hasCanonicalSubscriptionHost } from './request.js';
import { renderSubscription, sendMaintenanceResponse } from './response.js';

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
  sharedHostname: sharedHostnameOption = process.env.ADMIN_PUBLIC_HOSTNAME,
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
  const sharedHostname = canonicalSharedHostname(sharedHostnameOption);
  // This aggregate bucket is deliberately limited to malformed requests.
  // Reverse proxies collapse socket addresses; untrusted traffic must not be
  // able to spend a verified subscriber's independent credential allowance.
  const allowMalformed = (req, res) => {
    const rate = globalRateLimiter.take(requestAddress(req));
    if (rate.allowed) return true;
    tooManyRequests(req, res, rate);
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
    if (!hasCanonicalSubscriptionHost(req, view, sharedHostname)) {
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
        tooManyRequests(req, res, invalidRate);
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
      tooManyRequests(req, res, credentialRate);
      return;
    }

    const rendered = renderSubscription(view, user, route[2] ?? 'mixed');
    const headers = { 'content-type': rendered.type };
    if (rendered.filename) headers['content-disposition'] = `attachment; filename="${rendered.filename}"`;
    sendResponse(req, res, 200, rendered.body, headers);
  };

  return createHttpService(handler, { host, port, ...httpOptions });
}
