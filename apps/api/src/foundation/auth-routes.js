import { LANDING, PARTNER_WELCOME_PATH, passwordPolicyErrors, permissionsFor } from '#domain';
import { recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { assertBelow, clear, consume, recordFailure } from '../auth/rate-limit.js';
import {
  activeRoles,
  clearSessionCookie,
  createSession,
  loadSession,
  revokeOtherSessions,
  revokeSession,
  revokeUserSessions,
} from '../auth/session.js';
import { hashToken } from '../auth/tokens.js';
import { RATE_LIMITS } from '../config/security.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { clientIp, readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { hasActivePartnerProfile } from '../partners/profile-routes.js';

/**
 * Payload for the web: who is signed in, which role is active, what it may do and where it lands.
 * `mustChangePassword`: signed in with a temporary password; nothing else works until it is changed.
 * `partnerProfile`: an approved partner; without any role yet (no merchant) it lands on the partner welcome page.
 * @param {{ userId: string, email: string, displayName: string, preferredLanguage: string, mustChangePassword?: boolean }} user
 * @param {import('../auth/session.js').RoleOption[]} roles
 * @param {string | null} roleAssignmentId
 * @param {boolean} partnerProfile
 */
function profile(user, roles, roleAssignmentId, partnerProfile) {
  const active = roles.find((option) => option.roleAssignmentId === roleAssignmentId) ?? null;
  return {
    user: {
      id: user.userId,
      email: user.email,
      displayName: user.displayName,
      preferredLanguage: user.preferredLanguage,
    },
    mustChangePassword: user.mustChangePassword === true,
    activeRole: active,
    roles,
    permissions: permissionsFor(active?.role),
    landing: active ? LANDING[active.role] : roles.length === 0 && partnerProfile ? PARTNER_WELCOME_PATH : null,
    needsRoleSelection: !active && roles.length > 1,
    partnerProfile,
  };
}

/**
 * @param {Parameters<typeof profile>[0]} user
 * @param {string | null} roleAssignmentId
 */
async function currentProfile(user, roleAssignmentId) {
  const [roles, partnerProfile] = await Promise.all([activeRoles(user.userId), hasActivePartnerProfile(user.userId)]);
  return profile(user, roles, roleAssignmentId, partnerProfile);
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
  const accountKey = `login:account:${email}:${ip}`;

  await consume(`login:ip:${ip}`, RATE_LIMITS.loginIp);
  await assertBelow(accountKey, RATE_LIMITS.loginAccount);

  const users = await collection('users');
  const account = email
    ? await users.findOne(
        { email },
        {
          projection: {
            email: 1,
            displayName: 1,
            preferredLanguage: 1,
            status: 1,
            passwordHash: 1,
            mustChangePassword: 1,
            tempPasswordExpiresAt: 1,
          },
        },
      )
    : null;
  const passwordOk = await verifyPassword(password, account?.passwordHash);

  if (!account || !passwordOk || account.status !== 'ACTIVE') {
    await recordFailure(accountKey, RATE_LIMITS.loginAccount);
    await recordAudit({
      eventType: 'SIGN_IN_FAILED',
      entityType: 'user_account',
      entityId: account?._id ?? null,
      after: { email, ip },
      correlationId: ctx.requestId,
    });
    throw invalidCredentials();
  }

  const mustChangePassword = account.mustChangePassword === true;
  if (mustChangePassword && !(account.tempPasswordExpiresAt > new Date())) {
    await recordAudit({
      eventType: 'SIGN_IN_FAILED',
      entityType: 'user_account',
      entityId: account._id,
      after: { email, ip },
      reason: 'TEMP_PASSWORD_EXPIRED',
      correlationId: ctx.requestId,
    });
    throw new HttpError(401, 'TEMP_PASSWORD_EXPIRED', 'This temporary password has expired. Ask the platform admin for a new one.');
  }

  const [roles, partnerProfile] = await Promise.all([activeRoles(account._id), hasActivePartnerProfile(account._id)]);
  // An approved partner who has joined no merchant yet signs in without a role.
  if (roles.length === 0 && !partnerProfile) throw new HttpError(403, 'NO_ACTIVE_ROLE', 'This account has no active role');

  // One role: use it. Several: the user must choose; never pick the highest (C3).
  const chosen = roles.length === 1 ? roles[0] : null;
  const { cookie } = await createSession({
    userId: account._id,
    roleAssignmentId: chosen?.roleAssignmentId ?? null,
    role: chosen?.role ?? null,
    ip,
    userAgent: String(req.headers['user-agent'] ?? ''),
  });
  await clear(accountKey);
  await recordAudit({
    eventType: 'SIGN_IN',
    tenantId: chosen?.tenantId ?? null,
    actorUserId: account._id,
    actorRoleAssignmentId: chosen?.roleAssignmentId ?? null,
    entityType: 'user_account',
    entityId: account._id,
    after: { role: chosen?.role ?? null, ip },
    correlationId: ctx.requestId,
  });

  const user = {
    userId: account._id,
    email: account.email,
    displayName: account.displayName,
    preferredLanguage: account.preferredLanguage,
    mustChangePassword,
  };
  sendJson(res, 200, profile(user, roles, chosen?.roleAssignmentId ?? null, partnerProfile), { 'Set-Cookie': cookie });
}

/**
 * Signed-in user replaces the current password (required after a temporary one); other sessions end.
 * @type {import('../http/router.js').Handler}
 */
async function changePassword(req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const body = await readJson(req);
  const currentPassword = stringField(body, 'currentPassword', { max: 256 });
  const newPassword = stringField(body, 'newPassword', { max: 256 });
  await consume(`password-change:user:${session.userId}`, RATE_LIMITS.passwordChangeUser);

  const users = await collection('users');
  const account = await users.findOne({ _id: session.userId, status: 'ACTIVE' }, { projection: { passwordHash: 1 } });
  if (!account || !(await verifyPassword(currentPassword, account.passwordHash))) {
    throw new HttpError(422, 'CURRENT_PASSWORD_WRONG', 'The current password is incorrect', { details: { field: 'currentPassword' } });
  }
  assertPasswordPolicy(newPassword);
  if (newPassword === currentPassword) {
    throw new HttpError(422, 'PASSWORD_UNCHANGED', 'Choose a password different from the current one', { details: { field: 'newPassword' } });
  }
  const passwordHash = await hashPassword(newPassword);

  await withTransaction(async (tx) => {
    const now = new Date();
    await users.updateOne(
      { _id: session.userId },
      { $set: { passwordHash, passwordChangedAt: now, updatedAt: now }, $unset: { mustChangePassword: '', tempPasswordExpiresAt: '' } },
      { session: tx },
    );
    await revokeOtherSessions(session.userId, session.sessionId, { session: tx });
    await recordAudit(
      {
        eventType: 'PASSWORD_CHANGED',
        tenantId: session.tenantId,
        actorUserId: session.userId,
        actorRoleAssignmentId: session.roleAssignmentId,
        entityType: 'user_account',
        entityId: session.userId,
        after: { temporaryReplaced: session.mustChangePassword },
        correlationId: ctx.requestId,
      },
      { session: tx },
    );
  });
  sendJson(res, 200, await currentProfile({ ...session, mustChangePassword: false }, session.roleAssignmentId));
}

/** @type {import('../http/router.js').Handler} */
async function logout(req, res, ctx) {
  const session = await loadSession(req);
  if (session) {
    await revokeSession(session.sessionId);
    await recordAudit({
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

/**
 * A session without a role whose account now has exactly one (a partner just added by a merchant, or
 * whose other roles ended) switches to it, as sign-in would.
 * @type {import('../http/router.js').Handler}
 */
async function me(req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  if (!session.roleAssignmentId) {
    const roles = await activeRoles(session.userId);
    if (roles.length === 1) {
      const cookie = await switchRole(req, ctx, session, roles[0]);
      const partnerProfile = await hasActivePartnerProfile(session.userId);
      return sendJson(res, 200, profile(session, roles, roles[0].roleAssignmentId, partnerProfile), { 'Set-Cookie': cookie });
    }
  }
  sendJson(res, 200, await currentProfile(session, session.roleAssignmentId));
}

/**
 * Replaces the session with one on `chosen`: a new session ID on every role change (§8.1).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('../http/router.js').Context} ctx
 * @param {import('../auth/session.js').Session} session
 * @param {import('../auth/session.js').RoleOption} chosen
 */
async function switchRole(req, ctx, session, chosen) {
  const { cookie } = await withTransaction(async (tx) => {
    await revokeSession(session.sessionId, { session: tx });
    const created = await createSession(
      {
        userId: session.userId,
        roleAssignmentId: chosen.roleAssignmentId,
        role: chosen.role,
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] ?? ''),
      },
      { session: tx },
    );
    await recordAudit(
      {
        eventType: 'ROLE_SELECTED',
        tenantId: chosen.tenantId,
        actorUserId: session.userId,
        actorRoleAssignmentId: chosen.roleAssignmentId,
        entityType: 'role_assignment',
        entityId: chosen.roleAssignmentId,
        before: { role: session.role },
        after: { role: chosen.role },
        correlationId: ctx.requestId,
      },
      { session: tx },
    );
    return created;
  });
  return cookie;
}

/** @type {import('../http/router.js').Handler} */
async function selectRole(req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const body = await readJson(req);
  const roleAssignmentId = stringField(body, 'roleAssignmentId', { max: 64 });
  const roles = await activeRoles(session.userId);
  const chosen = roles.find((option) => option.roleAssignmentId === roleAssignmentId);
  if (!chosen) throw new HttpError(403, 'ROLE_NOT_AVAILABLE', 'This role is not available');
  const cookie = await switchRole(req, ctx, session, chosen);
  sendJson(res, 200, profile(session, roles, chosen.roleAssignmentId, await hasActivePartnerProfile(session.userId)), { 'Set-Cookie': cookie });
}

const invalidInvitation = () =>
  new HttpError(410, 'INVITATION_INVALID', 'This invitation link is no longer valid. Ask your admin for a new one.');

/**
 * An unused, unexpired link whose user is in `userStatus`; null otherwise.
 * @param {'invitations' | 'passwordResets'} kind
 * @param {string} token
 * @param {string} userStatus
 * @param {{ session?: import('mongodb').ClientSession }} [options]
 */
async function findOpenLink(kind, token, userStatus, options = {}) {
  const links = await collection(kind);
  const link = await links.findOne(
    { tokenHash: hashToken(token), usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } },
    options,
  );
  if (!link) return null;
  const users = await collection('users');
  const user = await users.findOne(
    { _id: link.userId, status: userStatus },
    { ...options, projection: { email: 1, displayName: 1, preferredLanguage: 1 } },
  );
  return user ? { link, user } : null;
}

/**
 * Marks the link used only if it is still open, so two concurrent submits cannot both succeed.
 * @param {'invitations' | 'passwordResets'} kind
 * @param {string} linkId
 * @param {import('mongodb').ClientSession} session
 */
async function markUsed(kind, linkId, session) {
  const links = await collection(kind);
  const { modifiedCount } = await links.updateOne(
    { _id: linkId, usedAt: null, revokedAt: null },
    { $set: { usedAt: new Date() } },
    { session },
  );
  return modifiedCount === 1;
}

/** @type {import('../http/router.js').Handler} */
async function inspectInvitation(req, res) {
  const body = await readJson(req);
  const token = stringField(body, 'token', { max: 128 });
  await consume(`token:ip:${clientIp(req)}`, RATE_LIMITS.tokenIp);
  const found = await findOpenLink('invitations', token, 'INVITED');
  if (!found) throw invalidInvitation();
  sendJson(res, 200, {
    email: found.user.email,
    displayName: found.user.displayName,
    preferredLanguage: found.user.preferredLanguage,
  });
}

/** @type {import('../http/router.js').Handler} */
async function acceptInvitation(req, res, ctx) {
  const body = await readJson(req);
  const token = stringField(body, 'token', { max: 128 });
  const password = stringField(body, 'password', { max: 256 });
  await consume(`token:ip:${clientIp(req)}`, RATE_LIMITS.tokenIp);
  assertPasswordPolicy(password);
  const passwordHash = await hashPassword(password);

  const email = await withTransaction(async (session) => {
    const found = await findOpenLink('invitations', token, 'INVITED', { session });
    if (!found || !(await markUsed('invitations', found.link._id, session))) throw invalidInvitation();
    const now = new Date();
    const users = await collection('users');
    const { modifiedCount } = await users.updateOne(
      { _id: found.user._id, status: 'INVITED' },
      { $set: { passwordHash, passwordChangedAt: now, status: 'ACTIVE', updatedAt: now } },
      { session },
    );
    if (modifiedCount !== 1) throw invalidInvitation();
    await recordAudit(
      {
        eventType: 'INVITATION_ACCEPTED',
        actorUserId: found.user._id,
        entityType: 'invitation',
        entityId: found.link._id,
        correlationId: ctx.requestId,
      },
      { session },
    );
    return found.user.email;
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
  await consume(`reset:ip:${clientIp(req)}`, RATE_LIMITS.resetRequestIp);
  await consume(`reset:email:${email}`, RATE_LIMITS.resetRequestEmail);

  const users = await collection('users');
  const user = email ? await users.findOne({ email, status: 'ACTIVE' }, { projection: { _id: 1 } }) : null;
  if (user) {
    await recordAudit({
      eventType: 'PASSWORD_RESET_REQUESTED',
      entityType: 'user_account',
      entityId: user._id,
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
  await consume(`token:ip:${clientIp(req)}`, RATE_LIMITS.tokenIp);
  assertPasswordPolicy(password);
  const passwordHash = await hashPassword(password);

  const email = await withTransaction(async (session) => {
    const found = await findOpenLink('passwordResets', token, 'ACTIVE', { session });
    if (!found || !(await markUsed('passwordResets', found.link._id, session))) {
      throw new HttpError(410, 'RESET_INVALID', 'This reset link is no longer valid. Ask your admin for a new one.');
    }
    const userId = found.user._id;
    const now = new Date();
    const users = await collection('users');
    await users.updateOne(
      { _id: userId },
      { $set: { passwordHash, passwordChangedAt: now, updatedAt: now }, $unset: { mustChangePassword: '', tempPasswordExpiresAt: '' } },
      { session },
    );
    const resets = await collection('passwordResets');
    await resets.updateMany({ userId, usedAt: null, revokedAt: null }, { $set: { revokedAt: now } }, { session });
    await revokeUserSessions(userId, { session });
    await recordAudit(
      {
        eventType: 'PASSWORD_RESET_COMPLETED',
        actorUserId: userId,
        entityType: 'user_account',
        entityId: userId,
        correlationId: ctx.requestId,
      },
      { session },
    );
    return found.user.email;
  });
  sendJson(res, 200, { ok: true, email }, { 'Set-Cookie': clearSessionCookie() });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const authRoutes = [
  { method: 'POST', path: '/api/v1/auth/login', handler: login },
  { method: 'POST', path: '/api/v1/auth/logout', handler: logout },
  { method: 'GET', path: '/api/v1/auth/me', handler: authed(me, { allowNoRole: true, allowPasswordChange: true }) },
  { method: 'POST', path: '/api/v1/auth/password/change', handler: authed(changePassword, { allowNoRole: true, allowPasswordChange: true }) },
  { method: 'POST', path: '/api/v1/auth/select-role', handler: authed(selectRole, { allowNoRole: true }) },
  { method: 'POST', path: '/api/v1/auth/invitations/inspect', handler: inspectInvitation },
  { method: 'POST', path: '/api/v1/auth/invitations/accept', handler: acceptInvitation },
  { method: 'POST', path: '/api/v1/auth/password-reset', handler: requestPasswordReset },
  { method: 'POST', path: '/api/v1/auth/password-reset/confirm', handler: confirmPasswordReset },
];
