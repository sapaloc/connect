import { passwordPolicyErrors, ROLES } from '@connect/domain';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { env, isLocalOrTest, requireEnv } from '../config/env.js';
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

async function main() {
  if (!isLocalOrTest) throw new Error(`seed: refused, APP_ENV is "${env.appEnv}" (only local/test)`);
  requireEnv('databaseUrl', 'seedPassword');
  if (passwordPolicyErrors(env.seedPassword).length) throw new Error('seed: SEED_PASSWORD does not meet the password policy');
  const client = new pg.Client(connectionConfig(env.databaseUrl));
  await client.connect();
  try {
    await client.query('BEGIN');
    await seed(client, env.seedPassword);
    await client.query('COMMIT');
    console.log(`seed: ${SEED_USERS.length} accounts in tenant ${SEED_TENANT} (password from SEED_PASSWORD)`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
