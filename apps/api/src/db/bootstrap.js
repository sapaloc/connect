import { hashPassword } from '../auth/password.js';

/** @typedef {import('pg').PoolClient | import('pg').Client} Db */

/**
 * Finds a tenant by name, creating it with its operating organization if missing.
 * @param {Db} db
 * @param {string} name
 */
export async function ensureTenant(db, name) {
  const found = await db.query('SELECT tenant_id FROM tenant WHERE name = $1', [name]);
  if (found.rows[0]) return /** @type {string} */ (found.rows[0].tenant_id);
  const party = await db.query(`INSERT INTO party (party_kind) VALUES ('ORGANIZATION') RETURNING party_id`);
  const partyId = party.rows[0].party_id;
  await db.query('INSERT INTO organization (party_id, legal_name, display_name) VALUES ($1, $2, $2)', [partyId, name]);
  const tenant = await db.query(
    'INSERT INTO tenant (operating_organization_id, name) VALUES ($1, $2) RETURNING tenant_id',
    [partyId, name],
  );
  return /** @type {string} */ (tenant.rows[0].tenant_id);
}

/**
 * Creates an ACTIVE account (or updates its password) and grants the role if missing.
 * @param {Db} db
 * @param {{ email: string, displayName: string, password: string, role: string, tenantId: string | null }} input
 */
export async function ensureActiveUser(db, { email, displayName, password, role, tenantId }) {
  const passwordHash = await hashPassword(password);
  const user = await db.query(
    `INSERT INTO user_account (email_or_login, display_name, account_status, password_hash, password_changed_at)
     VALUES ($1, $2, 'ACTIVE', $3, now())
     ON CONFLICT (email_or_login) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, password_changed_at = now(),
           account_status = 'ACTIVE', updated_at = now()
     RETURNING user_id`,
    [email.toLowerCase(), displayName, passwordHash],
  );
  const userId = user.rows[0].user_id;
  await db.query(
    `INSERT INTO role_assignment (user_id, role, scope_type, tenant_id)
     SELECT $1, $2, $3, $4
      WHERE NOT EXISTS (SELECT 1 FROM role_assignment WHERE user_id = $1 AND role = $2
                          AND tenant_id IS NOT DISTINCT FROM $4 AND status = 'ACTIVE')`,
    [userId, role, tenantId ? 'TENANT' : 'PLATFORM', tenantId],
  );
  return /** @type {string} */ (userId);
}
