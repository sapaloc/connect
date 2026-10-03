import { canInvite, roleConflict, ROLES } from '#domain';
import { randomUUID } from 'node:crypto';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { INVITATION_TTL_MS, PASSWORD_RESET_TTL_MS } from '../config/security.js';
import { grantRole } from '../db/bootstrap.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { publicOrigin, readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ROLES = [ROLES.TENANT_ADMIN, ROLES.MANAGER, ROLES.STAFF];

/** @param {import('../http/router.js').Context} ctx */
function sessionOf(ctx) {
  return /** @type {import('../auth/session.js').Session} */ (ctx.session);
}

/**
 * Tenant Admin works inside its own tenant; Platform Admin names the tenant explicitly.
 * @param {import('../auth/session.js').Session} session
 * @param {unknown} requested
 */
function targetTenant(session, requested) {
  if (session.role === ROLES.PLATFORM_ADMIN) {
    if (typeof requested !== 'string' || !UUID_PATTERN.test(requested)) {
      throw new HttpError(422, 'VALIDATION', 'tenantId is required', { details: { field: 'tenantId' } });
    }
    return requested.toLowerCase();
  }
  return /** @type {string} */ (session.tenantId);
}

/**
 * A single-use link (invitation or password reset); opening a new one revokes the previous ones.
 * @param {'invitations' | 'passwordResets'} kind
 * @param {{ userId: string, ttlMs: number, createdBy: string }} input
 * @param {import('mongodb').ClientSession} session
 */
async function issueLink(kind, { userId, ttlMs, createdBy }, session) {
  const links = await collection(kind);
  const now = new Date();
  await links.updateMany({ userId, usedAt: null, revokedAt: null }, { $set: { revokedAt: now } }, { session });
  const token = newToken();
  const linkId = randomUUID();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await links.insertOne(
    { _id: linkId, userId, tokenHash: hashToken(token), expiresAt, usedAt: null, revokedAt: null, createdBy, createdAt: now },
    { session },
  );
  return { linkId, token, expiresAt };
}

/** @type {import('../http/router.js').Handler} */
async function listUsers(req, res, ctx) {
  const session = sessionOf(ctx);
  const tenantId = targetTenant(session, new URL(req.url ?? '/', 'http://localhost').searchParams.get('tenantId'));
  const users = await collection('users');
  const members = await users
    .find(
      { roles: { $elemMatch: { tenantId, status: 'ACTIVE', role: { $in: TENANT_ROLES } } } },
      { projection: { email: 1, displayName: 1, status: 1, roles: 1 }, sort: { displayName: 1 } },
    )
    .toArray();
  const invitations = await collection('invitations');
  const open = await invitations.distinct('userId', {
    userId: { $in: members.map((user) => user._id) },
    usedAt: null,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  const withOpenInvitation = new Set(open);
  sendJson(res, 200, {
    users: members.map((user) => ({
      id: user._id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      roles: user.roles
        .filter(
          (/** @type {any} */ assignment) =>
            assignment.tenantId === tenantId && assignment.status === 'ACTIVE' && TENANT_ROLES.includes(assignment.role),
        )
        .map((/** @type {any} */ assignment) => assignment.role)
        .sort(),
      invitationOpen: withOpenInvitation.has(user._id),
    })),
  });
}

/**
 * @typedef {{ email: string, displayName: string, role: string, preferredLanguage: 'en' | 'vi' }} Invitee
 */

/**
 * Email, name and language of the person to invite.
 * @param {Record<string, unknown>} body
 * @returns {Omit<Invitee, 'role'>}
 */
export function parsePerson(body) {
  const email = stringField(body, 'email', { max: 254 }).trim().toLowerCase();
  const displayName = stringField(body, 'displayName', { max: 120 }).trim();
  const language = stringField(body, 'preferredLanguage', { max: 2, optional: true }) || 'en';
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(422, 'VALIDATION', 'email is invalid', { details: { field: 'email' } });
  if (!displayName) throw new HttpError(422, 'VALIDATION', 'displayName is required', { details: { field: 'displayName' } });
  if (language !== 'vi' && language !== 'en') {
    throw new HttpError(422, 'VALIDATION', 'preferredLanguage is invalid', { details: { field: 'preferredLanguage' } });
  }
  return { email, displayName, preferredLanguage: language };
}

/**
 * Reads and checks the person to invite; the acting role must be allowed to grant `role`.
 * @param {Record<string, unknown>} body
 * @param {import('../auth/session.js').Session} session
 * @returns {Invitee}
 */
export function parseInvitee(body, session) {
  const person = parsePerson(body);
  const role = stringField(body, 'role', { max: 32 });
  if (!canInvite(/** @type {string} */ (session.role), role)) {
    throw new HttpError(403, 'FORBIDDEN', 'You cannot invite this role');
  }
  return { ...person, role };
}

/**
 * Creates or re-sends an invitation to a tenant or partner role; an active account just gets the extra role.
 * Re-sending revokes the previous link (§8.1). The tenant must be ACTIVE (it may be created in `tx`).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('../http/router.js').Context} ctx
 * @param {Invitee & { tenantId: string, partnerRelationshipId?: string | null }} input
 * @param {import('mongodb').ClientSession} tx
 */
export async function inviteMember(req, ctx, { email, displayName, role, preferredLanguage, tenantId, partnerRelationshipId = null }, tx) {
  const session = sessionOf(ctx);
  const tenants = await collection('tenants');
  if (!(await tenants.countDocuments({ _id: tenantId, status: 'ACTIVE' }, { session: tx, limit: 1 }))) {
    throw new HttpError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
  }

  const users = await collection('users');
  const now = new Date();
  let user = await users.findOne({ email }, { session: tx, projection: { status: 1, roles: 1 } });
  if (user && user.status !== 'INVITED' && user.status !== 'ACTIVE') {
    throw new HttpError(409, 'USER_NOT_INVITABLE', 'This account is blocked or ended');
  }
  const conflict = user
    ? roleConflict(
        (user.roles ?? []).filter((/** @type {any} */ assignment) => assignment.status === 'ACTIVE'),
        { role, tenantId, partnerRelationshipId },
      )
    : null;
  if (conflict) throw new HttpError(409, conflict, 'This account already has a role that cannot be combined with this one');
  if (!user) {
    user = { _id: randomUUID(), status: 'INVITED' };
    await users.insertOne(
      {
        _id: user._id,
        email,
        displayName,
        status: 'INVITED',
        preferredLanguage,
        passwordHash: null,
        passwordChangedAt: null,
        roles: [],
        createdAt: now,
        updatedAt: now,
      },
      { session: tx },
    );
  }
  await grantRole(user._id, { role, tenantId, partnerRelationshipId, createdBy: session.userId }, { session: tx });

  // An active account just gets the extra role; it signs in with its current password.
  if (user.status === 'ACTIVE') {
    await recordAudit(
      { ...actorOf(ctx), tenantId, eventType: 'ROLE_GRANTED', entityType: 'user_account', entityId: user._id, after: { role } },
      { session: tx },
    );
    return { userId: user._id, status: 'ACTIVE', inviteUrl: null, expiresAt: null };
  }

  const link = await issueLink('invitations', { userId: user._id, ttlMs: INVITATION_TTL_MS, createdBy: session.userId }, tx);
  await recordAudit(
    {
      ...actorOf(ctx),
      tenantId,
      eventType: 'INVITATION_CREATED',
      entityType: 'invitation',
      entityId: link.linkId,
      after: { email, role },
    },
    { session: tx },
  );
  // Token in the URL fragment: never sent to the server or leaked through Referer / access logs.
  return {
    userId: user._id,
    status: 'INVITED',
    inviteUrl: `${publicOrigin(req)}/invite#${link.token}`,
    expiresAt: link.expiresAt.toISOString(),
  };
}

/**
 * The link is returned once to the admin, who sends it to the person (no email provider in V1).
 * @type {import('../http/router.js').Handler}
 */
async function inviteUser(req, res, ctx) {
  const session = sessionOf(ctx);
  const body = await readJson(req);
  const invitee = parseInvitee(body, session);
  const tenantId = targetTenant(session, body.tenantId);
  const result = await withTransaction((tx) => inviteMember(req, ctx, { ...invitee, tenantId }, tx));
  sendJson(res, 201, result);
}

/** @type {import('../http/router.js').Handler} */
async function issuePasswordReset(req, res, ctx) {
  const session = sessionOf(ctx);
  const userId = ctx.params.userId.toLowerCase();
  if (!UUID_PATTERN.test(userId)) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');

  const result = await withTransaction(async (tx) => {
    // Tenant Admin: only people with a tenant role in its own tenant. Platform Admin: any tenant role.
    const inScope = {
      status: 'ACTIVE',
      role: { $in: TENANT_ROLES },
      ...(session.role === ROLES.PLATFORM_ADMIN ? {} : { tenantId: session.tenantId }),
    };
    const users = await collection('users');
    const target = await users.findOne(
      { _id: userId, roles: { $elemMatch: inScope } },
      { session: tx, projection: { status: 1, roles: 1 } },
    );
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
    if (target.status !== 'ACTIVE') {
      throw new HttpError(409, 'USER_NOT_ACTIVE', 'Only active accounts can reset; re-send the invitation instead');
    }
    const targetTenantId = target.roles.find(
      (/** @type {any} */ assignment) =>
        assignment.status === 'ACTIVE' &&
        TENANT_ROLES.includes(assignment.role) &&
        (session.role === ROLES.PLATFORM_ADMIN || assignment.tenantId === session.tenantId),
    ).tenantId;

    const link = await issueLink('passwordResets', { userId, ttlMs: PASSWORD_RESET_TTL_MS, createdBy: session.userId }, tx);
    await recordAudit(
      {
        ...actorOf(ctx),
        tenantId: session.tenantId ?? targetTenantId,
        eventType: 'PASSWORD_RESET_ISSUED',
        entityType: 'password_reset',
        entityId: link.linkId,
        after: { userId },
      },
      { session: tx },
    );
    return { resetUrl: `${publicOrigin(req)}/reset#${link.token}`, expiresAt: link.expiresAt.toISOString() };
  });

  sendJson(res, 201, result);
}

/** @type {import('../http/router.js').RouteDef[]} */
export const userRoutes = [
  { method: 'GET', path: '/api/v1/users', handler: authed(listUsers, { permission: 'user.list' }) },
  { method: 'POST', path: '/api/v1/users/invitations', handler: authed(inviteUser, { permission: 'user.invite' }) },
  {
    method: 'POST',
    path: '/api/v1/users/:userId/password-reset',
    handler: authed(issuePasswordReset, { permission: 'user.reset_link' }),
  },
];
