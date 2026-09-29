import { can } from '#domain';
import { getPool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { clearSessionCookie, loadSession } from './session.js';

/**
 * Wraps a handler so it only runs for a signed-in user whose active role holds `permission`.
 * @param {import('../http/router.js').Handler} handler
 * @param {{ permission?: string, allowNoRole?: boolean }} [options]
 * @returns {import('../http/router.js').Handler}
 */
export function authed(handler, { permission, allowNoRole = false } = {}) {
  return async (req, res, ctx) => {
    const session = await loadSession(getPool(), req);
    if (!session) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required', {
        headers: { 'Set-Cookie': clearSessionCookie() },
      });
    }
    if (!session.role && !allowNoRole) throw new HttpError(403, 'ROLE_NOT_SELECTED', 'Choose a role first');
    if (permission && !can(session.role, permission)) throw new HttpError(403, 'FORBIDDEN', 'Not allowed for this role');
    await handler(req, res, { ...ctx, session });
  };
}
