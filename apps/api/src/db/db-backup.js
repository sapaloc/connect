import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { env, requireEnv } from '../config/env.js';
import { exportDatabase } from './backup.js';
import { closeClient, getDb } from './mongo.js';

// Usage: pnpm db:backup [--out backups]   e.g. MONGODB_URI=<uat uri> APP_ENV=uat pnpm db:backup
const { values } = parseArgs({ options: { out: { type: 'string', default: 'backups' } } });
requireEnv('mongodbUri');

try {
  const backup = await exportDatabase(await getDb());
  await mkdir(values.out, { recursive: true });
  const file = join(values.out, backup.fileName);
  await writeFile(file, backup.body);
  console.log(`db:backup: ${file} (${backup.body.length} bytes) from "${env.mongodbDb}"`, backup.counts);
} finally {
  await closeClient();
}
