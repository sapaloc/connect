import { parseArgs } from 'node:util';
import { env, requireEnv } from '../config/env.js';
import { resetSchema } from './reset.js';
import { assertCanSeed, seedOnce } from './seed-local.js';

const USAGE = `Usage: pnpm db:reset --confirm <APP_ENV>
Deletes ALL data (drops the public schema), re-runs migrations and seeds the test accounts.
Allowed on local/test/uat only. --confirm must repeat the current APP_ENV, e.g. --confirm uat`;

const { values } = parseArgs({ options: { confirm: { type: 'string' } } });
if (values.confirm !== env.appEnv) {
  console.error(USAGE);
  process.exit(1);
}
assertCanSeed();
requireEnv('databaseMigrationUrl');

await resetSchema(env.databaseMigrationUrl);
console.log(`db:reset: schema recreated on ${env.appEnv}`);
await seedOnce(env.databaseMigrationUrl);
