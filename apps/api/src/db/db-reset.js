import { parseArgs } from 'node:util';
import { env, requireEnv } from '../config/env.js';
import { closeClient } from './mongo.js';
import { resetDatabase } from './reset.js';
import { assertCanSeed, seedOnce } from './seed-local.js';

const USAGE = `Usage: pnpm db:reset --confirm <APP_ENV>
Deletes ALL data (drops the MONGODB_DB database), re-runs db:setup and seeds the test accounts.
Allowed on local/test/uat only. --confirm must repeat the current APP_ENV, e.g. --confirm uat`;

const { values } = parseArgs({ options: { confirm: { type: 'string' } } });
if (values.confirm !== env.appEnv) {
  console.error(USAGE);
  process.exit(1);
}
assertCanSeed();
requireEnv('mongodbUri');

try {
  await resetDatabase();
  console.log(`db:reset: database "${env.mongodbDb}" recreated on ${env.appEnv}`);
  await seedOnce();
} finally {
  await closeClient();
}
