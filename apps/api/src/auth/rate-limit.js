import { rateLimited } from '../http/errors.js';

/**
 * Fixed windows counted in Postgres, because serverless instances share no memory.
 * @param {{ windowMs: number }} limit
 */
function windowOf(limit) {
  const now = Date.now();
  const start = now - (now % limit.windowMs);
  return { start: new Date(start), retryAfter: Math.max(1, Math.ceil((start + limit.windowMs - now) / 1000)) };
}

/**
 * Counts one attempt and throws 429 once the limit is exceeded.
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {string} key
 * @param {{ max: number, windowMs: number }} limit
 */
export async function consume(db, key, limit) {
  const window = windowOf(limit);
  const { rows } = await db.query(
    `INSERT INTO rate_limit_bucket (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_bucket.count + 1
     RETURNING count`,
    [key, window.start],
  );
  if (rows[0].count > limit.max) throw rateLimited(window.retryAfter);
}

/**
 * Throws 429 if the key already reached the limit, without counting.
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {string} key
 * @param {{ max: number, windowMs: number }} limit
 */
export async function assertBelow(db, key, limit) {
  const window = windowOf(limit);
  const { rows } = await db.query('SELECT count FROM rate_limit_bucket WHERE key = $1 AND window_start = $2', [
    key,
    window.start,
  ]);
  if ((rows[0]?.count ?? 0) >= limit.max) throw rateLimited(window.retryAfter);
}

/**
 * Counts one failure without throwing; the next attempt is blocked by assertBelow.
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {string} key
 * @param {{ windowMs: number }} limit
 */
export async function recordFailure(db, key, limit) {
  const window = windowOf(limit);
  await db.query(
    `INSERT INTO rate_limit_bucket (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_bucket.count + 1`,
    [key, window.start],
  );
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {string} key
 */
export async function clear(db, key) {
  await db.query('DELETE FROM rate_limit_bucket WHERE key = $1', [key]);
}
