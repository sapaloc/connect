import { passwordPolicyErrors, ROLES } from '#domain';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { recordAudit } from '../audit/audit.js';
import { requireEnv } from '../config/env.js';
import { ensureActiveUser, ensureTenant } from './bootstrap.js';
import { closeClient } from './mongo.js';
import { withTransaction } from './tx.js';

const USAGE = `Usage: pnpm user:create --email <email> --name <display name> --role <ROLE> [--tenant <tenant name>]
Roles: PLATFORM_ADMIN (no tenant), TENANT_ADMIN, MANAGER, STAFF
The password is typed at the prompt and never stored in shell history or the repo.
Targets MONGODB_URI / MONGODB_DB, e.g. MONGODB_URI=<uat uri> pnpm user:create ...`;

/** @param {string} question */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    // @ts-expect-error readline has no public API to mute echo
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, tenant: { type: 'string' } },
  });
  const { email, name, role, tenant } = values;
  const tenantRoles = [ROLES.TENANT_ADMIN, ROLES.MANAGER, ROLES.STAFF];
  const validRole = role === ROLES.PLATFORM_ADMIN ? !tenant : tenantRoles.includes(/** @type {string} */ (role)) && tenant;
  if (!email || !name || !role || !validRole) {
    console.error(USAGE);
    process.exit(1);
  }

  requireEnv('mongodbUri');
  const password = await promptHidden('Password: ');
  const errors = passwordPolicyErrors(password);
  if (errors.length) throw new Error(`Password rejected: ${errors.join(', ')} (8–32 chars, upper, lower, digit, special)`);
  if ((await promptHidden('Repeat password: ')) !== password) throw new Error('Passwords do not match');

  try {
    await withTransaction(async (session) => {
      const tenantId = tenant ? await ensureTenant(tenant, { session }) : null;
      const userId = await ensureActiveUser({ email, displayName: name, password, role, tenantId }, { session });
      await recordAudit(
        {
          eventType: 'USER_CREATED_BY_SCRIPT',
          tenantId,
          entityType: 'user_account',
          entityId: userId,
          after: { email, role },
          reason: 'user:create',
        },
        { session },
      );
    });
    console.log(`user:create: ${email} is ACTIVE with role ${role}${tenant ? ` in ${tenant}` : ''}`);
  } finally {
    await closeClient();
  }
}

await main();
