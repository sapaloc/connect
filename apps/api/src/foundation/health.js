import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { sendJson } from '../http/respond.js';

/** @type {import('../http/router.js').Handler} */
export async function health(_req, res) {
  let db = 'ok';
  try {
    await getPool().query('SELECT 1');
  } catch (error) {
    db = 'error';
    console.error(JSON.stringify({ level: 'error', msg: 'health db check failed', err: error.message }));
  }
  sendJson(res, db === 'ok' ? 200 : 503, {
    status: db === 'ok' ? 'ok' : 'degraded',
    env: env.appEnv,
    commit: env.commitSha.slice(0, 7),
    db,
  });
}
