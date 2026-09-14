import { ControlError } from '../../control/socket/client-transport.js';
import { HttpError, readForm } from '../shared/input.js';
import { sendGenericError, sendResponse, tooManyRequests } from '../shared/service.js';
import { PASSWORD_BYTES } from '../../core/identity/credentials.js';
import { html, redirect } from '../admin/auth.js';
import { exactForm, sessionRateKey, valueOnce } from '../admin/request.js';
import { renderAccountPage } from './portal-page.js';

const LOGIN_PATH = '/account/login';
const DOWNLOAD_ROUTE = /^\/account\/downloads\/(links|sing-box|clash)$/u;
// Content types and filenames are fixed here; nothing from the socket reaches a header.
const DOWNLOADS = new Map([
  ['links', ['text/plain; charset=utf-8', 'vless-links.txt']],
  ['sing-box', ['application/json; charset=utf-8', 'sing-box.json']],
  ['clash', ['application/yaml; charset=utf-8', 'clash.yaml']],
]);
const MAX_DOWNLOAD_BYTES = 256 * 1024;
const PASSWORD_FAILURES = new Map([
  ['PASSWORD_MISMATCH', ['currentPassword', 'Current password is incorrect.']],
  ['PASSWORD_UNCHANGED', ['newPassword', 'Choose a different password.']],
  ['INVALID', ['newPassword', `Use between ${PASSWORD_BYTES.min} characters and ${PASSWORD_BYTES.max} bytes.`]],
]);

function localPasswordError(currentPassword, newPassword, confirmPassword) {
  if (currentPassword === '') return ['currentPassword', 'Enter your current password.'];
  const bytes = Buffer.byteLength(newPassword, 'utf8');
  if (bytes < PASSWORD_BYTES.min) return ['newPassword', `Use at least ${PASSWORD_BYTES.min} characters.`];
  if (bytes > PASSWORD_BYTES.max) return ['newPassword', `Use at most ${PASSWORD_BYTES.max} bytes.`];
  if (confirmPassword !== newPassword) return ['confirmPassword', 'The new passwords do not match.'];
  if (newPassword === currentPassword) return ['newPassword', 'Choose a different password.'];
  return null;
}

/** Authenticated portal routes; every page renders from a fresh account snapshot. */
export function createAccountRoutes({ control, publicOrigin, sendAccountError, clearSession, accountMutationRateLimiter }) {
  const sendPortal = async (req, res, sessionId, status = 200, options = {}) => {
    try {
      const snapshot = await control.accountSnapshot(sessionId);
      if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.csrf !== 'string') {
        throw new ControlError('INTERNAL', 500);
      }
      html(req, res, status, renderAccountPage(snapshot, { publicOrigin, ...options }));
    } catch (error) {
      sendAccountError(req, res, error);
    }
  };

  const download = async (req, res, sessionId, format) => {
    try {
      const result = await control.accountExport(sessionId, format);
      const body = result?.body;
      if (result?.format !== format || typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_DOWNLOAD_BYTES) {
        throw new ControlError('INTERNAL', 500);
      }
      const [type, filename] = DOWNLOADS.get(format);
      sendResponse(req, res, 200, body, {
        'content-type': type,
        'content-disposition': `attachment; filename="${filename}"`,
      });
    } catch (error) {
      sendAccountError(req, res, error);
    }
  };

  const changePassword = async (req, res, sessionId, csrf, form, spendBudget) => {
    exactForm(form, ['csrf', 'currentPassword', 'newPassword', 'confirmPassword']);
    const bounds = { min: 0, max: 1024 };
    const currentPassword = valueOnce(form, 'currentPassword', bounds);
    const newPassword = valueOnce(form, 'newPassword', bounds);
    const confirmPassword = valueOnce(form, 'confirmPassword', bounds);
    const localError = localPasswordError(currentPassword, newPassword, confirmPassword);
    if (localError) {
      await sendPortal(req, res, sessionId, 400, { passwordError: localError });
      return;
    }
    if (!spendBudget()) return;
    try {
      await control.accountChangePassword(sessionId, csrf, currentPassword, newPassword);
    } catch (error) {
      const flagged = PASSWORD_FAILURES.get(error?.code);
      if (!flagged || error.status !== 400) throw error;
      await sendPortal(req, res, sessionId, 400, { passwordError: flagged });
      return;
    }
    // Redirect after the change so a refresh can never resubmit the old form.
    redirect(req, res, '/account/password-changed');
  };

  return async (req, res, url, sessionId) => {
    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (reading && url.pathname === '/account') {
      await sendPortal(req, res, sessionId);
      return;
    }
    if (reading && url.pathname === '/account/password-changed') {
      await sendPortal(req, res, sessionId, 200, { notice: 'Password changed. Other signed-in devices were signed out.' });
      return;
    }
    const downloadRoute = DOWNLOAD_ROUTE.exec(url.pathname);
    if (reading && downloadRoute) {
      await download(req, res, sessionId, downloadRoute[1]);
      return;
    }
    if (req.method !== 'POST') {
      sendGenericError(req, res, 404);
      return;
    }

    // Form mistakes cost nothing; only requests that reach the controller spend the budget.
    const spendBudget = () => {
      const rate = accountMutationRateLimiter.take(sessionRateKey(sessionId));
      if (rate.allowed) return true;
      tooManyRequests(req, res, rate);
      return false;
    };
    let form;
    let csrf;
    try {
      form = await readForm(req, { maxBytes: 16 * 1024, timeoutMs: 5_000 });
      csrf = valueOnce(form, 'csrf', { min: 1, max: 512 });
    } catch (error) {
      sendGenericError(req, res, error instanceof HttpError ? error.status : 400);
      return;
    }
    try {
      if (url.pathname === '/account/logout') {
        exactForm(form, ['csrf']);
        // Signing out is never budgeted or blockable: the server session ends whenever the
        // controller answers, and the cookie goes regardless.
        await control.accountLogout(sessionId, csrf).catch(() => {});
        redirect(req, res, LOGIN_PATH, { 'set-cookie': clearSession });
        return;
      }
      if (url.pathname === '/account/rotate-token') {
        exactForm(form, ['csrf']);
        if (!spendBudget()) return;
        const result = await control.accountRotateToken(sessionId, csrf);
        if (typeof result?.rawToken !== 'string' || typeof result?.csrf !== 'string') throw new ControlError('INTERNAL', 500);
        // The token is already rotated: a failing follow-up snapshot must not swallow its only showing.
        const snapshot = await control.accountSnapshot(sessionId).catch(() => null);
        const page = snapshot && typeof snapshot.csrf === 'string'
          ? snapshot
          : { csrf: result.csrf, ready: true, user: result.user, usage: null, gateway: {}, exits: [], connections: [] };
        html(req, res, 200, renderAccountPage(page, { publicOrigin, credentials: result }));
        return;
      }
      if (url.pathname === '/account/password') {
        await changePassword(req, res, sessionId, csrf, form, spendBudget);
        return;
      }
      sendGenericError(req, res, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        sendGenericError(req, res, error.status);
        return;
      }
      sendAccountError(req, res, error);
    }
  };
}
