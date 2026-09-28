import { passwordPolicyErrors, ROLES } from '@connect/domain';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { env, requireEnv } from '../config/env.js';
import { ensureActiveUser, ensureTenant } from './bootstrap.js';
import { connectionConfig } from './connection.js';

const USAGE = `Usage: pnpm user:create --email <email> --name <display name> --role <ROLE> [--tenant <tenant name>]
Roles: PLATFORM_ADMIN (no tenant), TENANT_ADMIN, MANAGER, STAFF
The password is typed at the prompt and never stored in shell history or the repo.
Targets DATABASE_URL, e.g. DATABASE_URL=<uat pooler url> pnpm user:create ...`;

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

  requireEnv('databaseUrl');
  const password = await promptHidden('Password: ');
  const errors = passwordPolicyErrors(password);
  if (errors.length) throw new Error(`Password rejected: ${errors.join(', ')} (8–32 chars, upper, lower, digit, special)`);
  if ((await promptHidden('Repeat password: ')) !== password) throw new Error('Passwords do not match');

  const client = new pg.Client(connectionConfig(env.databaseUrl));
  await client.connect();
  try {
    await client.query('BEGIN');
    const tenantId = tenant ? await ensureTenant(client, tenant) : null;
    const userId = await ensureActiveUser(client, { email, displayName: name, password, role, tenantId });
    await client.query(
      `INSERT INTO audit_event (tenant_id, event_type, entity_type, entity_id, after_json, reason)
       VALUES ($1, 'USER_CREATED_BY_SCRIPT', 'user_account', $2, $3, 'user:create')`,
      [tenantId, userId, JSON.stringify({ email, role })],
    );
    await client.query('COMMIT');
    console.log(`user:create: ${email} is ACTIVE with role ${role}${tenant ? ` in ${tenant}` : ''}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

await main();
