import { canInvite, ROLES } from '@connect/domain';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { INVITATION_TTL_MS, PASSWORD_RESET_TTL_MS } from '../config/security.js';
import { getPool } from '../db/pool.js';
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
    return requested;
  }
  return /** @type {string} */ (session.tenantId);
}

/** @type {import('../http/router.js').Handler} */
async function listUsers(req, res, ctx) {
  const session = sessionOf(ctx);
  const tenantId = targetTenant(session, new URL(req.url ?? '/', 'http://localhost').searchParams.get('tenantId'));
  const { rows } = await getPool().query(
    `SELECT u.user_id, u.email_or_login, u.display_name, u.account_status,
            array_agg(ra.role ORDER BY ra.role) AS roles,
            EXISTS (SELECT 1 FROM invitation i WHERE i.user_id = u.user_id AND i.used_at IS NULL
                      AND i.revoked_at IS NULL AND i.expires_at > now()) AS invitation_open
       FROM user_account u
       JOIN role_assignment ra ON ra.user_id = u.user_id AND ra.status = 'ACTIVE' AND ra.tenant_id = $1
      GROUP BY u.user_id
      ORDER BY u.display_name`,
    [tenantId],
  );
  sendJson(res, 200, {
    users: rows.map((row) => ({
      id: row.user_id,
      email: row.email_or_login,
      displayName: row.display_name,
      status: row.account_status,
      roles: row.roles,
      invitationOpen: row.invitation_open,
    })),
  });
}

/**
 * Creates or re-sends an invitation. Re-sending revokes the previous link (§8.1).
 * The link is returned once to the admin, who sends it to the person (no email provider in V1).
 * @type {import('../http/router.js').Handler}
 */
async function inviteUser(req, res, ctx) {
  const session = sessionOf(ctx);
  const body = await readJson(req);
  const email = stringField(body, 'email', { max: 254 }).trim().toLowerCase();
  const displayName = stringField(body, 'displayName', { max: 120 }).trim();
  const role = stringField(body, 'role', { max: 32 });
  const language = stringField(body, 'preferredLanguage', { max: 2, optional: true }) || 'vi';
  const tenantId = targetTenant(session, body.tenantId);

  if (!EMAIL_PATTERN.test(email)) throw new HttpError(422, 'VALIDATION', 'email is invalid', { details: { field: 'email' } });
  if (!displayName) throw new HttpError(422, 'VALIDATION', 'displayName is required', { details: { field: 'displayName' } });
  if (language !== 'vi' && language !== 'en') {
    throw new HttpError(422, 'VALIDATION', 'preferredLanguage is invalid', { details: { field: 'preferredLanguage' } });
  }
  if (!canInvite(/** @type {string} */ (session.role), role)) {
    throw new HttpError(403, 'FORBIDDEN', 'You cannot invite this role');
  }

  const result = await withTransaction(async (client) => {
    const tenant = await client.query(`SELECT 1 FROM tenant WHERE tenant_id = $1 AND status = 'ACTIVE'`, [tenantId]);
    if (!tenant.rowCount) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Tenant not found');

    const existing = await client.query(
      'SELECT user_id, account_status FROM user_account WHERE email_or_login = $1 FOR UPDATE',
      [email],
    );
    let user = existing.rows[0];
    if (user && user.account_status !== 'INVITED' && user.account_status !== 'ACTIVE') {
      throw new HttpError(409, 'USER_NOT_INVITABLE', 'This account is blocked or ended');
    }
    if (!user) {
      const created = await client.query(
        `INSERT INTO user_account (email_or_login, display_name, preferred_language)
         VALUES ($1, $2, $3) RETURNING user_id, account_status`,
        [email, displayName, language],
      );
      user = created.rows[0];
    }

    await client.query(
      `INSERT INTO role_assignment (user_id, role, scope_type, tenant_id, created_by)
       SELECT $1, $2, 'TENANT', $3, $4
        WHERE NOT EXISTS (SELECT 1 FROM role_assignment WHERE user_id = $1 AND role = $2
                            AND tenant_id = $3 AND status = 'ACTIVE')`,
      [user.user_id, role, tenantId, session.userId],
    );

    // An active account just gets the extra role; it signs in with its current password.
    if (user.account_status === 'ACTIVE') {
      await recordAudit(client, {
        ...actorOf(ctx),
        tenantId,
        eventType: 'ROLE_GRANTED',
        entityType: 'user_account',
        entityId: user.user_id,
        after: { role },
      });
      return { userId: user.user_id, status: 'ACTIVE', inviteUrl: null, expiresAt: null };
    }

    await client.query(
      'UPDATE invitation SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL',
      [user.user_id],
    );
    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const invitation = await client.query(
      `INSERT INTO invitation (user_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4) RETURNING invitation_id`,
      [user.user_id, hashToken(token), expiresAt, session.userId],
    );
    await recordAudit(client, {
      ...actorOf(ctx),
      tenantId,
      eventType: 'INVITATION_CREATED',
      entityType: 'invitation',
      entityId: invitation.rows[0].invitation_id,
      after: { email, role },
    });
    // Token in the URL fragment: never sent to the server or leaked through Referer / access logs.
    return {
      userId: user.user_id,
      status: 'INVITED',
      inviteUrl: `${publicOrigin(req)}/invite#${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  });

  sendJson(res, 201, result);
}

/** @type {import('../http/router.js').Handler} */
async function issuePasswordReset(req, res, ctx) {
  const session = sessionOf(ctx);
  const userId = ctx.params.userId;
  if (!UUID_PATTERN.test(userId)) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');

  const result = await withTransaction(async (client) => {
    // Tenant Admin: only people with a tenant role in its own tenant. Platform Admin: any tenant role.
    const scope = await client.query(
      `SELECT tenant_id FROM role_assignment
        WHERE user_id = $1 AND status = 'ACTIVE' AND role = ANY($3) AND ($2::uuid IS NULL OR tenant_id = $2)
        LIMIT 1`,
      [userId, session.role === ROLES.PLATFORM_ADMIN ? null : session.tenantId, TENANT_ROLES],
    );
    if (!scope.rowCount) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
    const { rows } = await client.query('SELECT user_id, account_status FROM user_account WHERE user_id = $1 FOR UPDATE', [
      userId,
    ]);
    const target = { ...rows[0], tenant_id: scope.rows[0].tenant_id };
    if (target.account_status !== 'ACTIVE') {
      throw new HttpError(409, 'USER_NOT_ACTIVE', 'Only active accounts can reset; re-send the invitation instead');
    }

    await client.query(
      'UPDATE password_reset SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL',
      [userId],
    );
    const token = newToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    const reset = await client.query(
      `INSERT INTO password_reset (user_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4) RETURNING password_reset_id`,
      [userId, hashToken(token), expiresAt, session.userId],
    );
    await recordAudit(client, {
      ...actorOf(ctx),
      tenantId: session.tenantId ?? target.tenant_id,
      eventType: 'PASSWORD_RESET_ISSUED',
      entityType: 'password_reset',
      entityId: reset.rows[0].password_reset_id,
      after: { userId },
    });
    return { resetUrl: `${publicOrigin(req)}/reset#${token}`, expiresAt: expiresAt.toISOString() };
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
