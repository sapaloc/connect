import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { env, isLocalOrTest, requireEnv } from '../config/env.js';
import { restoreDatabase } from './backup.js';
import { closeClient, getDb } from './mongo.js';

const USAGE = `Usage: pnpm db:restore --file <backup.json.gz> --confirm <APP_ENV>
Replaces ALL data in MONGODB_DB with the backup. Allowed on local/test/uat; --confirm must repeat APP_ENV.`;

const { values } = parseArgs({ options: { file: { type: 'string' }, confirm: { type: 'string' } } });
if (!values.file || values.confirm !== env.appEnv) {
  console.error(USAGE);
  process.exit(1);
}
if (!isLocalOrTest && env.appEnv !== 'uat') throw new Error(`refused, APP_ENV is "${env.appEnv}" (only local/test/uat)`);
requireEnv('mongodbUri');

try {
  const result = await restoreDatabase(await getDb(), await readFile(values.file));
  console.log(`db:restore: "${env.mongodbDb}" on ${env.appEnv} restored from backup of ${result.createdAt.toISOString()}`, result.counts);
} finally {
  await closeClient();
}
