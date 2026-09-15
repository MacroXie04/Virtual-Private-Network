import { renderClientSubscription } from '../../core/subscriptions/clients.js';
import { sendResponse } from '../shared/service.js';

export function renderSubscription(view, user, format) {
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

export function sendMaintenanceResponse(req, res) {
  sendResponse(req, res, 503, 'Service Unavailable\n', {
    'content-type': 'text/plain; charset=utf-8',
    'retry-after': '1',
  });
}
