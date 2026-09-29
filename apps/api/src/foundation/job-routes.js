import { timingSafeEqual } from 'node:crypto';
import { recordAudit } from '../audit/audit.js';
import { env } from '../config/env.js';
import { runBackupJob } from '../db/backup.js';
import { getDb } from '../db/mongo.js';
import { HttpError } from '../http/errors.js';
import { sendJson } from '../http/respond.js';

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; anything else is rejected the same way.
 * @param {import('node:http').IncomingMessage} req
 */
function assertCron(req) {
  const expected = Buffer.from(`Bearer ${env.cronSecret}`);
  const actual = Buffer.from(String(req.headers.authorization ?? ''));
  if (!env.cronSecret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Job secret required');
  }
}

/** @type {import('../http/router.js').Handler} */
async function backup(req, res, ctx) {
  assertCron(req);
  const result = await runBackupJob(await getDb());
  await recordAudit({
    eventType: 'DATABASE_BACKUP_CREATED',
    entityType: 'backup',
    entityId: result.path,
    after: { bytes: result.bytes, counts: result.counts, removed: result.removed },
    correlationId: ctx.requestId,
  });
  console.log(JSON.stringify({ level: 'info', msg: 'backup created', ...result }));
  sendJson(res, 200, result);
}

/** @type {import('../http/router.js').RouteDef[]} */
export const jobRoutes = [{ method: 'GET', path: '/api/v1/internal/jobs/backup', handler: backup }];
