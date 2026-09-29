import { parseArgs } from 'node:util';
import { env, requireEnv } from '../config/env.js';
import { BACKUP_KEEP, writeBackup } from './backup.js';
import { closeClient, getDb } from './mongo.js';

// Usage: pnpm db:backup [--out backups] [--keep 30]
// e.g. node --env-file=$HOME/.config/connect/uat.env apps/api/src/db/db-backup.js --out ~/Backups/connect-uat
const { values } = parseArgs({
  options: { out: { type: 'string', default: 'backups' }, keep: { type: 'string', default: String(BACKUP_KEEP) } },
});
requireEnv('mongodbUri');

try {
  const result = await writeBackup(await getDb(), values.out, Math.max(1, Number(values.keep) || BACKUP_KEEP));
  console.log(`db:backup: ${result.file} (${result.bytes} bytes, removed ${result.removed} old) from "${env.mongodbDb}"`, result.counts);
} finally {
  await closeClient();
}
