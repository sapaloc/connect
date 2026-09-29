import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE, SESSION_TOUCH_INTERVAL_MS, sessionTtl } from '../config/security.js';
import { collection } from '../db/mongo.js';
import { parseCookies, serializeCookie } from '../http/cookies.js';
import { hashToken, newToken } from './tokens.js';

/**
 * @typedef {{
 *   sessionId: string,
 *   userId: string,
 *   email: string,
 *   displayName: string,
 *   preferredLanguage: 'en' | 'vi',
 *   roleAssignmentId: string | null,
 *   role: string | null,
 *   scopeType: string | null,
 *   tenantId: string | null,
 *   partnerRelationshipId: string | null,
 *   affiliatedReferrerId: string | null,
 *   supportSession: boolean,
 * }} Session
 *
 * @typedef {{
 *   roleAssignmentId: string,
 *   role: string,
 *   scopeType: string,
 *   tenantId: string | null,
 *   tenantName: string | null,
 * }} RoleOption
 *
 * @typedef {{ session?: import('mongodb').ClientSession }} TxOptions
 */

/**
 * @param {any} assignment role assignment embedded in `users.roles`
 * @param {Date} now
 */
function isCurrent(assignment, now) {
  return assignment.status === 'ACTIVE' && assignment.validFrom <= now && (!assignment.validUntil || assignment.validUntil > now);
}

/**
 * Names of the ACTIVE tenants among `tenantIds`; a paused or ended tenant is missing from the map.
 * @param {(string | null)[]} tenantIds
 * @param {TxOptions} options
 */
async function activeTenantNames(tenantIds, options) {
  const ids = [...new Set(tenantIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const tenants = await collection('tenants');
  const rows = await tenants.find({ _id: { $in: ids }, status: 'ACTIVE' }, { ...options, projection: { name: 1 } }).toArray();
  return new Map(rows.map((tenant) => [tenant._id, tenant.name]));
}

/**
 * Role assignments usable right now; an ended assignment or a paused tenant gives no access.
 * @param {string} userId
 * @param {TxOptions} [options]
 * @returns {Promise<RoleOption[]>}
 */
export async function activeRoles(userId, options = {}) {
  const users = await collection('users');
  const user = await users.findOne({ _id: userId }, { ...options, projection: { roles: 1 } });
  const now = new Date();
  const current = (user?.roles ?? []).filter((/** @type {any} */ assignment) => isCurrent(assignment, now));
  const names = await activeTenantNames(current.map((/** @type {any} */ assignment) => assignment.tenantId), options);
  return current
    .filter((/** @type {any} */ assignment) => !assignment.tenantId || names.has(assignment.tenantId))
    .map((/** @type {any} */ assignment) => ({
      roleAssignmentId: assignment._id,
      role: assignment.role,
      scopeType: assignment.scopeType,
      tenantId: assignment.tenantId,
      tenantName: assignment.tenantId ? names.get(assignment.tenantId) : null,
    }))
    .sort(
      (a, b) =>
        (a.tenantName === null ? -1 : 0) - (b.tenantName === null ? -1 : 0) ||
        (a.tenantName ?? '').localeCompare(b.tenantName ?? '') ||
        a.role.localeCompare(b.role),
    );
}

/**
 * @param {{ userId: string, roleAssignmentId: string | null, role: string | null, ip: string, userAgent: string }} input
 * @param {TxOptions} [options]
 */
export async function createSession({ userId, roleAssignmentId, role, ip, userAgent }, options = {}) {
  const token = newToken();
  const ttl = sessionTtl(role);
  const now = new Date();
  const sessions = await collection('sessions');
  await sessions.insertOne(
    {
      _id: randomUUID(),
      tokenHash: hashToken(token),
      userId,
      roleAssignmentId,
      supportSession: false,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + ttl.idleMs),
      absoluteExpiresAt: new Date(now.getTime() + ttl.absoluteMs),
      revokedAt: null,
      ip,
      userAgent: userAgent.slice(0, 300),
    },
    options,
  );
  return { token, cookie: serializeCookie(SESSION_COOKIE, token, ttl.absoluteMs / 1000) };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Session | null>}
 */
export async function loadSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const now = new Date();
  const sessions = await collection('sessions');
  const session = await sessions.findOne({
    tokenHash: hashToken(token),
    revokedAt: null,
    idleExpiresAt: { $gt: now },
    absoluteExpiresAt: { $gt: now },
  });
  if (!session) return null;

  const users = await collection('users');
  const user = await users.findOne(
    { _id: session.userId, status: 'ACTIVE' },
    { projection: { email: 1, displayName: 1, preferredLanguage: 1, roles: 1 } },
  );
  if (!user) return null;

  let assignment = null;
  if (session.roleAssignmentId) {
    assignment = user.roles.find((/** @type {any} */ candidate) => candidate._id === session.roleAssignmentId);
    if (!assignment || !isCurrent(assignment, now)) return null;
    if (assignment.tenantId && !(await activeTenantNames([assignment.tenantId], {})).size) return null;
  }

  if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    const ttl = sessionTtl(assignment?.role);
    const idle = Math.min(now.getTime() + ttl.idleMs, session.absoluteExpiresAt.getTime());
    await sessions.updateOne({ _id: session._id }, { $set: { lastSeenAt: now, idleExpiresAt: new Date(idle) } });
  }

  return {
    sessionId: session._id,
    userId: user._id,
    email: user.email,
    displayName: user.displayName,
    preferredLanguage: user.preferredLanguage,
    roleAssignmentId: session.roleAssignmentId,
    role: assignment?.role ?? null,
    scopeType: assignment?.scopeType ?? null,
    tenantId: assignment?.tenantId ?? null,
    partnerRelationshipId: assignment?.partnerRelationshipId ?? null,
    affiliatedReferrerId: assignment?.affiliatedReferrerId ?? null,
    supportSession: session.supportSession,
  };
}

/**
 * @param {string} sessionId
 * @param {TxOptions} [options]
 */
export async function revokeSession(sessionId, options = {}) {
  const sessions = await collection('sessions');
  await sessions.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: new Date() } }, options);
}

/**
 * @param {string} userId
 * @param {TxOptions} [options]
 */
export async function revokeUserSessions(userId, options = {}) {
  const sessions = await collection('sessions');
  await sessions.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } }, options);
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', 0);
}
