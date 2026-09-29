import { LANDING, passwordPolicyErrors, permissionsFor } from '#domain';
import { recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { assertBelow, clear, consume, recordFailure } from '../auth/rate-limit.js';
import {
  activeRoles,
  clearSessionCookie,
  createSession,
  loadSession,
  revokeSession,
  revokeUserSessions,
} from '../auth/session.js';
import { hashToken } from '../auth/tokens.js';
import { RATE_LIMITS } from '../config/security.js';
import { getPool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { clientIp, readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';

/**
 * Payload for the web: who is signed in, which role is active, what it may do and where it lands.
 * @param {{ userId: string, email: string, displayName: string, preferredLanguage: string }} user
 * @param {import('../auth/session.js').RoleOption[]} roles
 * @param {string | null} roleAssignmentId
 */
function profile(user, roles, roleAssignmentId) {
  const active = roles.find((option) => option.roleAssignmentId === roleAssignmentId) ?? null;
  return {
    user: {
      id: user.userId,
      email: user.email,
      displayName: user.displayName,
      preferredLanguage: user.preferredLanguage,
    },
    activeRole: active,
    roles,
    permissions: permissionsFor(active?.role),
    landing: active ? LANDING[active.role] : null,
    needsRoleSelection: !active && roles.length > 1,
  };
}

const invalidCredentials = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

/** @param {unknown} email */
function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
}

/** @param {string} password */
function assertPasswordPolicy(password) {
  const errors = passwordPolicyErrors(password);
  if (errors.length) {
    throw new HttpError(422, 'PASSWORD_POLICY', 'Password does not meet the policy', { details: { rules: errors } });
  }
}

/** @type {import('../http/router.js').Handler} */
async function login(req, res, ctx) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const ip = clientIp(req);
  const db = getPool();
  const accountKey = `login:account:${email}:${ip}`;

  await consume(db, `login:ip:${ip}`, RATE_LIMITS.loginIp);
  await assertBelow(db, accountKey, RATE_LIMITS.loginAccount);

  const { rows } = await db.query(
    `SELECT user_id, email_or_login, display_name, preferred_language, account_status, password_hash
       FROM user_account WHERE email_or_login = $1`,
    [email],
  );
  const account = rows[0];
  const passwordOk = await verifyPassword(password, account?.password_hash);

  if (!account || !passwordOk || account.account_status !== 'ACTIVE') {
    await recordFailure(db, accountKey, RATE_LIMITS.loginAccount);
    await recordAudit(db, {
      eventType: 'SIGN_IN_FAILED',
      entityType: 'user_account',
      entityId: account?.user_id ?? null,
      after: { email, ip },
      correlationId: ctx.requestId,
    });
    throw invalidCredentials();
  }

  const roles = await activeRoles(db, account.user_id);
  if (roles.length === 0) throw new HttpError(403, 'NO_ACTIVE_ROLE', 'This account has no active role');

  // One role: use it. Several: the user must choose; never pick the highest (C3).
  const chosen = roles.length === 1 ? roles[0] : null;
  const { cookie } = await createSession(db, {
    userId: account.user_id,
    roleAssignmentId: chosen?.roleAssignmentId ?? null,
    role: chosen?.role ?? null,
    ip,
    userAgent: String(req.headers['user-agent'] ?? ''),
  });
  await clear(db, accountKey);
  await recordAudit(db, {
    eventType: 'SIGN_IN',
    tenantId: chosen?.tenantId ?? null,
    actorUserId: account.user_id,
    actorRoleAssignmentId: chosen?.roleAssignmentId ?? null,
    entityType: 'user_account',
    entityId: account.user_id,
    after: { role: chosen?.role ?? null, ip },
    correlationId: ctx.requestId,
  });

  const user = {
    userId: account.user_id,
    email: account.email_or_login,
    displayName: account.display_name,
    preferredLanguage: account.preferred_language,
  };
  sendJson(res, 200, profile(user, roles, chosen?.roleAssignmentId ?? null), { 'Set-Cookie': cookie });
}

/** @type {import('../http/router.js').Handler} */
async function logout(req, res, ctx) {
  const db = getPool();
  const session = await loadSession(db, req);
  if (session) {
    await revokeSession(db, session.sessionId);
    await recordAudit(db, {
      eventType: 'SIGN_OUT',
      tenantId: session.tenantId,
      actorUserId: session.userId,
      actorRoleAssignmentId: session.roleAssignmentId,
      entityType: 'user_account',
      entityId: session.userId,
      correlationId: ctx.requestId,
    });
  }
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
}

/** @type {import('../http/router.js').Handler} */
async function me(_req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const roles = await activeRoles(getPool(), session.userId);
  sendJson(res, 200, profile(session, roles, session.roleAssignmentId));
}

/** @type {import('../http/router.js').Handler} */
async function selectRole(req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const body = await readJson(req);
  const roleAssignmentId = stringField(body, 'roleAssignmentId', { max: 64 });
  const db = getPool();
  const roles = await activeRoles(db, session.userId);
  const chosen = roles.find((option) => option.roleAssignmentId === roleAssignmentId);
  if (!chosen) throw new HttpError(403, 'ROLE_NOT_AVAILABLE', 'This role is not available');

  // New session ID on every role change (§8.1).
  const { cookie } = await withTransaction(async (client) => {
    await revokeSession(client, session.sessionId);
    const created = await createSession(client, {
      userId: session.userId,
      roleAssignmentId: chosen.roleAssignmentId,
      role: chosen.role,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
    await recordAudit(client, {
      eventType: 'ROLE_SELECTED',
      tenantId: chosen.tenantId,
      actorUserId: session.userId,
      actorRoleAssignmentId: chosen.roleAssignmentId,
      entityType: 'role_assignment',
      entityId: chosen.roleAssignmentId,
      before: { role: session.role },
      after: { role: chosen.role },
      correlationId: ctx.requestId,
    });
    return created;
  });
  sendJson(res, 200, profile(session, roles, chosen.roleAssignmentId), { 'Set-Cookie': cookie });
}

const invalidInvitation = () =>
  new HttpError(410, 'INVITATION_INVALID', 'This invitation link is no longer valid. Ask your admin for a new one.');

/**
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {string} token
 * @param {boolean} lock
 */
async function findOpenInvitation(db, token, lock) {
  const { rows } = await db.query(
    `SELECT i.invitation_id, i.user_id, u.email_or_login, u.display_name, u.preferred_language
       FROM invitation i
       JOIN user_account u ON u.user_id = i.user_id
      WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > now() AND u.account_status = 'INVITED'
      ${lock ? 'FOR UPDATE OF i, u' : ''}`,
    [hashToken(token)],
  );
  return rows[0];
}

/** @type {import('../http/router.js').Handler} */
async function inspectInvitation(req, res) {
  const body = await readJson(req);
  const token = stringField(body, 'token', { max: 128 });
  await consume(getPool(), `token:ip:${clientIp(req)}`, RATE_LIMITS.tokenIp);
  const invitation = await findOpenInvitation(getPool(), token, false);
  if (!invitation) throw invalidInvitation();
  sendJson(res, 200, {
    email: invitation.email_or_login,
    displayName: invitation.display_name,
    preferredLanguage: invitation.preferred_language,
  });
}

/** @type {import('../http/router.js').Handler} */
async function acceptInvitation(req, res, ctx) {
  const body = await readJson(req);
  const token = stringField(body, 'token', { max: 128 });
  const password = stringField(body, 'password', { max: 256 });
  await consume(getPool(), `token:ip:${clientIp(req)}`, RATE_LIMITS.tokenIp);
  assertPasswordPolicy(password);
  const passwordHash = await hashPassword(password);

  const email = await withTransaction(async (client) => {
    const invitation = await findOpenInvitation(client, token, true);
    if (!invitation) throw invalidInvitation();
    await client.query(
      `UPDATE user_account SET password_hash = $2, password_changed_at = now(), account_status = 'ACTIVE',
              updated_at = now() WHERE user_id = $1`,
      [invitation.user_id, passwordHash],
    );
    await client.query('UPDATE invitation SET used_at = now() WHERE invitation_id = $1', [invitation.invitation_id]);
    await recordAudit(client, {
      eventType: 'INVITATION_ACCEPTED',
      actorUserId: invitation.user_id,
      entityType: 'invitation',
      entityId: invitation.invitation_id,
      correlationId: ctx.requestId,
    });
    return invitation.email_or_login;
  });
  sendJson(res, 200, { ok: true, email });
}

/**
 * V1 has no email provider: the request is recorded for the admin, and the response is the
 * same whether or not the email exists (§8.1).
 * @type {import('../http/router.js').Handler}
 */
async function requestPasswordReset(req, res, ctx) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const db = getPool();
  await consume(db, `reset:ip:${clientIp(req)}`, RATE_LIMITS.resetRequestIp);
  await consume(db, `reset:email:${email}`, RATE_LIMITS.resetRequestEmail);

  const { rows } = await db.query(
    `SELECT user_id FROM user_account WHERE email_or_login = $1 AND account_status = 'ACTIVE'`,
    [email],
  );
  if (rows[0]) {
    await recordAudit(db, {
      eventType: 'PASSWORD_RESET_REQUESTED',
      entityType: 'user_account',
      entityId: rows[0].user_id,
      correlationId: ctx.requestId,
    });
  }
  sendJson(res, 202, { ok: true });
}

/** @type {import('../http/router.js').Handler} */
async function confirmPasswordReset(req, res, ctx) {
  const body = await readJson(req);
  const token = stringField(body, 'token', { max: 128 });
  const password = stringField(body, 'password', { max: 256 });
  await consume(getPool(), `token:ip:${clientIp(req)}`, RATE_LIMITS.tokenIp);
  assertPasswordPolicy(password);
  const passwordHash = await hashPassword(password);

  const email = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT r.password_reset_id, r.user_id, u.email_or_login
         FROM password_reset r
         JOIN user_account u ON u.user_id = r.user_id
        WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.revoked_at IS NULL
          AND r.expires_at > now() AND u.account_status = 'ACTIVE'
        FOR UPDATE OF r, u`,
      [hashToken(token)],
    );
    const reset = rows[0];
    if (!reset) {
      throw new HttpError(410, 'RESET_INVALID', 'This reset link is no longer valid. Ask your admin for a new one.');
    }
    await client.query(
      'UPDATE user_account SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE user_id = $1',
      [reset.user_id, passwordHash],
    );
    await client.query('UPDATE password_reset SET used_at = now() WHERE password_reset_id = $1', [
      reset.password_reset_id,
    ]);
    await client.query(
      'UPDATE password_reset SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL',
      [reset.user_id],
    );
    await revokeUserSessions(client, reset.user_id);
    await recordAudit(client, {
      eventType: 'PASSWORD_RESET_COMPLETED',
      actorUserId: reset.user_id,
      entityType: 'user_account',
      entityId: reset.user_id,
      correlationId: ctx.requestId,
    });
    return reset.email_or_login;
  });
  sendJson(res, 200, { ok: true, email }, { 'Set-Cookie': clearSessionCookie() });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const authRoutes = [
  { method: 'POST', path: '/api/v1/auth/login', handler: login },
  { method: 'POST', path: '/api/v1/auth/logout', handler: logout },
  { method: 'GET', path: '/api/v1/auth/me', handler: authed(me, { allowNoRole: true }) },
  { method: 'POST', path: '/api/v1/auth/select-role', handler: authed(selectRole, { allowNoRole: true }) },
  { method: 'POST', path: '/api/v1/auth/invitations/inspect', handler: inspectInvitation },
  { method: 'POST', path: '/api/v1/auth/invitations/accept', handler: acceptInvitation },
  { method: 'POST', path: '/api/v1/auth/password-reset', handler: requestPasswordReset },
  { method: 'POST', path: '/api/v1/auth/password-reset/confirm', handler: confirmPasswordReset },
];
