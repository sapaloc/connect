import { passwordPolicyErrors, ROLES } from '#domain';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { canSeedTestAccounts, env, requireEnv } from '../config/env.js';
import { ensureActiveUser, ensureTenant } from './bootstrap.js';
import { connectionConfig } from './connection.js';

export const SEED_TENANT = 'Number160';

export const SEED_USERS = Object.freeze([
  { email: 'platform@connect.local', displayName: 'Platform Admin', roles: [ROLES.PLATFORM_ADMIN] },
  { email: 'admin@number160.local', displayName: 'Tenant Admin', roles: [ROLES.TENANT_ADMIN] },
  { email: 'manager@number160.local', displayName: 'Manager', roles: [ROLES.MANAGER] },
  { email: 'staff@number160.local', displayName: 'Staff', roles: [ROLES.STAFF] },
  { email: 'multi@number160.local', displayName: 'Admin + Manager', roles: [ROLES.TENANT_ADMIN, ROLES.MANAGER] },
]);

/**
 * @param {import('pg').Client} client
 * @param {string} password
 */
export async function seed(client, password) {
  const tenantId = await ensureTenant(client, SEED_TENANT);
  for (const user of SEED_USERS) {
    for (const role of user.roles) {
      await ensureActiveUser(client, {
        email: user.email,
        displayName: user.displayName,
        password,
        role,
        tenantId: role === ROLES.PLATFORM_ADMIN ? null : tenantId,
      });
    }
  }
  return tenantId;
}

/**
 * True once any seed account exists, so later runs never touch passwords or roles changed during testing.
 * @param {import('pg').Client} client
 */
export async function isSeeded(client) {
  const { rows } = await client.query('SELECT 1 FROM user_account WHERE email_or_login = ANY($1) LIMIT 1', [
    SEED_USERS.map((user) => user.email),
  ]);
  return rows.length > 0;
}

export function assertCanSeed() {
  if (!canSeedTestAccounts) throw new Error(`refused, APP_ENV is "${env.appEnv}" (only local/test/uat)`);
  requireEnv('seedPassword');
  if (passwordPolicyErrors(env.seedPassword).length) throw new Error('SEED_PASSWORD does not meet the password policy');
}

/** @param {string} connectionString */
export async function seedOnce(connectionString) {
  const client = new pg.Client(connectionConfig(connectionString));
  await client.connect();
  try {
    if (await isSeeded(client)) {
      console.log('seed: skipped, test accounts already exist (use pnpm db:reset to start over)');
      return;
    }
    await client.query('BEGIN');
    await seed(client, env.seedPassword);
    await client.query('COMMIT');
    console.log(`seed: ${SEED_USERS.length} accounts in tenant ${SEED_TENANT} (password from SEED_PASSWORD)`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertCanSeed();
  requireEnv('databaseUrl');
  await seedOnce(env.databaseUrl);
}
