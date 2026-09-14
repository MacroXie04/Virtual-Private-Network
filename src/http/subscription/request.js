import { validatePublicDnsHostname } from '../../core/validation/ingress.js';

export const TOKEN_ROUTE = /^\/s\/([A-Za-z0-9_-]{32,256})(?:\/(links|sing-box|clash))?$/u;

export function canonicalSharedHostname(value) {
  return value === undefined ? null : validatePublicDnsHostname(value, 'ADMIN_PUBLIC_HOSTNAME');
}

export function hasCanonicalSubscriptionHost(req, view, sharedHostname) {
  const hosts = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'host') hosts.push(req.rawHeaders[index + 1]);
  }
  if (hosts.length !== 1) return false;
  try {
    const hostname = validatePublicDnsHostname(hosts[0], 'Host');
    return hostname === view.gateway.subscriptionPublicHostname || hostname === sharedHostname;
  } catch {
    return false;
  }
}
