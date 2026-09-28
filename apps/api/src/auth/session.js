import { SESSION_COOKIE, SESSION_TOUCH_INTERVAL_MS, sessionTtl } from '../config/security.js';
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
 */

/** @typedef {import('pg').Pool | import('pg').PoolClient} Db */

/**
 * Role assignments usable right now; an ended assignment or a paused tenant gives no access.
 * @param {Db} db
 * @param {string} userId
 * @returns {Promise<RoleOption[]>}
 */
export async function activeRoles(db, userId) {
  const { rows } = await db.query(
    `SELECT ra.role_assignment_id, ra.role, ra.scope_type, ra.tenant_id, t.name AS tenant_name
       FROM role_assignment ra
       LEFT JOIN tenant t ON t.tenant_id = ra.tenant_id
      WHERE ra.user_id = $1
        AND ra.status = 'ACTIVE'
        AND ra.valid_from <= now()
        AND (ra.valid_until IS NULL OR ra.valid_until > now())
        AND (ra.tenant_id IS NULL OR t.status = 'ACTIVE')
      ORDER BY t.name NULLS FIRST, ra.role`,
    [userId],
  );
  return rows.map((row) => ({
    roleAssignmentId: row.role_assignment_id,
    role: row.role,
    scopeType: row.scope_type,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
  }));
}

/**
 * @param {Db} db
 * @param {{ userId: string, roleAssignmentId: string | null, role: string | null, ip: string, userAgent: string }} input
 */
export async function createSession(db, { userId, roleAssignmentId, role, ip, userAgent }) {
  const token = newToken();
  const ttl = sessionTtl(role);
  const now = Date.now();
  const absoluteExpiresAt = new Date(now + ttl.absoluteMs);
  await db.query(
    `INSERT INTO session (token_hash, user_id, role_assignment_id, idle_expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      hashToken(token),
      userId,
      roleAssignmentId,
      new Date(now + ttl.idleMs),
      absoluteExpiresAt,
      ip,
      userAgent.slice(0, 300),
    ],
  );
  return { token, cookie: serializeCookie(SESSION_COOKIE, token, ttl.absoluteMs / 1000) };
}

/**
 * @param {Db} db
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Session | null>}
 */
export async function loadSession(db, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT s.session_id, s.user_id, s.role_assignment_id, s.support_session, s.last_seen_at, s.absolute_expires_at,
            u.email_or_login, u.display_name, u.preferred_language,
            ra.role, ra.scope_type, ra.tenant_id, ra.partner_relationship_id, ra.affiliated_referrer_id
       FROM session s
       JOIN user_account u ON u.user_id = s.user_id AND u.account_status = 'ACTIVE'
       LEFT JOIN role_assignment ra ON ra.role_assignment_id = s.role_assignment_id
       LEFT JOIN tenant t ON t.tenant_id = ra.tenant_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > now()
        AND s.absolute_expires_at > now()
        AND (s.role_assignment_id IS NULL OR (
              ra.status = 'ACTIVE'
              AND ra.valid_from <= now()
              AND (ra.valid_until IS NULL OR ra.valid_until > now())
              AND (ra.tenant_id IS NULL OR t.status = 'ACTIVE')))`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;

  if (Date.now() - new Date(row.last_seen_at).getTime() > SESSION_TOUCH_INTERVAL_MS) {
    const ttl = sessionTtl(row.role);
    await db.query(
      `UPDATE session SET last_seen_at = now(),
              idle_expires_at = LEAST(now() + make_interval(secs => $2), absolute_expires_at)
        WHERE session_id = $1`,
      [row.session_id, ttl.idleMs / 1000],
    );
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email_or_login,
    displayName: row.display_name,
    preferredLanguage: row.preferred_language,
    roleAssignmentId: row.role_assignment_id,
    role: row.role,
    scopeType: row.scope_type,
    tenantId: row.tenant_id,
    partnerRelationshipId: row.partner_relationship_id,
    affiliatedReferrerId: row.affiliated_referrer_id,
    supportSession: row.support_session,
  };
}

/**
 * @param {Db} db
 * @param {string} sessionId
 */
export async function revokeSession(db, sessionId) {
  await db.query('UPDATE session SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL', [sessionId]);
}

/**
 * @param {Db} db
 * @param {string} userId
 */
export async function revokeUserSessions(db, userId) {
  await db.query('UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', 0);
}
