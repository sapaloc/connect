import { passwordPolicyErrors, ROLES } from '#domain';
import { pathToFileURL } from 'node:url';
import { canSeedTestAccounts, env, requireEnv } from '../config/env.js';
import { ensureActiveUser, ensureTenant } from './bootstrap.js';
import { closeClient, collection } from './mongo.js';
import { withTransaction } from './tx.js';

export const SEED_TENANT = 'Number160';

export const SEED_USERS = Object.freeze([
  { email: 'platform@connect.local', displayName: 'Platform Admin', roles: [ROLES.PLATFORM_ADMIN] },
  { email: 'admin@number160.local', displayName: 'Tenant Admin', roles: [ROLES.TENANT_ADMIN] },
  { email: 'manager@number160.local', displayName: 'Manager', roles: [ROLES.MANAGER] },
  { email: 'staff@number160.local', displayName: 'Staff', roles: [ROLES.STAFF] },
  { email: 'multi@number160.local', displayName: 'Admin + Manager', roles: [ROLES.TENANT_ADMIN, ROLES.MANAGER] },
]);

/** @param {string} password */
export function seed(password) {
  return withTransaction(async (session) => {
    const tenantId = await ensureTenant(SEED_TENANT, { session });
    for (const user of SEED_USERS) {
      for (const role of user.roles) {
        await ensureActiveUser(
          {
            email: user.email,
            displayName: user.displayName,
            password,
            role,
            tenantId: role === ROLES.PLATFORM_ADMIN ? null : tenantId,
          },
          { session },
        );
      }
    }
    return tenantId;
  });
}

/** True once any seed account exists, so later runs never touch passwords or roles changed during testing. */
export async function isSeeded() {
  const users = await collection('users');
  return (await users.countDocuments({ email: { $in: SEED_USERS.map((user) => user.email) } }, { limit: 1 })) > 0;
}

export function assertCanSeed() {
  if (!canSeedTestAccounts) throw new Error(`refused, APP_ENV is "${env.appEnv}" (only local/test/uat)`);
  requireEnv('seedPassword');
  if (passwordPolicyErrors(env.seedPassword).length) throw new Error('SEED_PASSWORD does not meet the password policy');
}

export async function seedOnce() {
  if (await isSeeded()) {
    console.log('seed: skipped, test accounts already exist (use pnpm db:reset to start over)');
    return;
  }
  await seed(env.seedPassword);
  console.log(`seed: ${SEED_USERS.length} accounts in tenant ${SEED_TENANT} (password from SEED_PASSWORD)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertCanSeed();
  requireEnv('mongodbUri');
  try {
    await seedOnce();
  } finally {
    await closeClient();
  }
}
