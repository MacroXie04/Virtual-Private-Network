import { HttpError } from '../shared/input.js';
import { renderUsersPage } from './pages/dashboard.js';
import { redirect } from './auth.js';
import { exactForm, valueOnce, operationIdFrom } from './request.js';

const IDENTIFIER = '[A-Za-z0-9_-]{1,128}';
const USER_ACTION_ROUTE = new RegExp(`^/users/(${IDENTIFIER})/(status|rename|revoke|reset-password|rotate-token|rotate-credentials)$`, 'u');
const EMPTY_NAME = 'Enter a display name.';
const NAME_ERRORS = new Map([
  ['DISPLAY_NAME_CONFLICT', 'This name is already in use.'],
  ['INVALID', 'Enter a valid display name of up to 64 characters without surrounding spaces.'],
  ['USER_LIMIT_REACHED', 'The limit of 256 users has been reached; revoke a user before creating another.'],
]);

/**
 * User mutation forms. Every outcome stays on the users page: one-time
 * credentials render inline, and name problems flag the field that caused them.
 */
export function createUserRoutes({ control, sendPage }) {
  const nameFailure = (error) => {
    const message = NAME_ERRORS.get(error?.code);
    if (!message) throw error;
    return message;
  };
  const usersPage = (req, res, sessionId, status, options) => sendPage(req, res, sessionId, renderUsersPage, status, options);

  return async (req, res, url, { form, csrf, sessionId, expectedRevision }) => {
    if (url.pathname === '/users') {
      exactForm(form, ['csrf', 'expectedRevision', 'displayName', 'operationId']);
      const displayName = valueOnce(form, 'displayName', { min: 0, max: 128 });
      const operationId = operationIdFrom(form);
      let createError = displayName.trim() === '' ? EMPTY_NAME : null;
      let result = null;
      if (createError === null) {
        try {
          result = await control.createUser(sessionId, csrf, expectedRevision, displayName, operationId);
        } catch (error) {
          createError = nameFailure(error);
        }
      }
      if (createError !== null) await usersPage(req, res, sessionId, 400, { createError });
      else await usersPage(req, res, sessionId, 201, { credentials: { heading: 'User created', result } });
      return true;
    }

    const route = USER_ACTION_ROUTE.exec(url.pathname);
    if (!route) return false;
    const [, userId, action] = route;
    if (action === 'status') {
      exactForm(form, ['csrf', 'expectedRevision', 'status']);
      const status = valueOnce(form, 'status', { max: 8 });
      if (status !== 'active' && status !== 'disabled') throw new HttpError(400);
      await control.setUserStatus(sessionId, csrf, expectedRevision, userId, status);
      redirect(req, res, '/users');
      return true;
    }
    if (action === 'rename') {
      exactForm(form, ['csrf', 'expectedRevision', 'displayName']);
      const displayName = valueOnce(form, 'displayName', { min: 0, max: 128 });
      let message = displayName.trim() === '' ? EMPTY_NAME : null;
      if (message === null) {
        try {
          await control.renameUser(sessionId, csrf, expectedRevision, userId, displayName);
        } catch (error) {
          message = nameFailure(error);
        }
      }
      if (message !== null) await usersPage(req, res, sessionId, 400, { renameError: { userId, message } });
      else redirect(req, res, '/users');
      return true;
    }
    if (action === 'revoke') {
      exactForm(form, ['csrf', 'expectedRevision', 'confirmName']);
      const confirmName = valueOnce(form, 'confirmName', { min: 0, max: 128 });
      const confirmed = confirmName.trim() !== '' && await control.revokeUser(
        sessionId, csrf, expectedRevision, userId, confirmName,
      ).then(() => true, (error) => {
        if (error?.code !== 'CONFIRMATION_MISMATCH') throw error;
        return false;
      });
      if (!confirmed) await usersPage(req, res, sessionId, 400, { revokeError: userId });
      else redirect(req, res, '/users');
      return true;
    }

    if (action === 'reset-password') {
      // Re-running a lost reset issues another password, so no replay id is needed.
      exactForm(form, ['csrf', 'expectedRevision']);
      const result = await control.resetUserPassword(sessionId, csrf, expectedRevision, userId);
      await usersPage(req, res, sessionId, 200, { credentials: { heading: 'Portal password reset', result } });
      return true;
    }

    exactForm(form, ['csrf', 'expectedRevision', 'operationId']);
    const operationId = operationIdFrom(form);
    const rotateToken = action === 'rotate-token';
    const result = rotateToken
      ? await control.rotateUserToken(sessionId, csrf, expectedRevision, userId, operationId)
      : await control.rotateUserCredentials(sessionId, csrf, expectedRevision, userId, operationId);
    const heading = rotateToken ? 'Subscription token rotated' : 'UUID and subscription token rotated';
    await usersPage(req, res, sessionId, 200, { credentials: { heading, result } });
    return true;
  };
}
