import { collection } from '../db/mongo.js';
import { rateLimited } from '../http/errors.js';

/**
 * Fixed windows counted in MongoDB, because serverless instances share no memory.
 * @param {string} key
 * @param {{ windowMs: number }} limit
 */
function windowOf(key, limit) {
  const now = Date.now();
  const start = now - (now % limit.windowMs);
  return {
    id: `${key}|${start}`,
    start: new Date(start),
    end: new Date(start + limit.windowMs),
    retryAfter: Math.max(1, Math.ceil((start + limit.windowMs - now) / 1000)),
  };
}

/**
 * Atomic +1 for the current window; the TTL index deletes the bucket when the window ends.
 * @param {string} key
 * @param {{ windowMs: number }} limit
 */
async function increment(key, limit) {
  const window = windowOf(key, limit);
  const buckets = await collection('rateLimits');
  const bucket = await buckets.findOneAndUpdate(
    { _id: window.id },
    { $inc: { count: 1 }, $setOnInsert: { key, windowStart: window.start, expiresAt: window.end } },
    { upsert: true, returnDocument: 'after', projection: { count: 1 } },
  );
  return { count: /** @type {number} */ (bucket?.count), window };
}

/**
 * Counts one attempt and throws 429 once the limit is exceeded.
 * @param {string} key
 * @param {{ max: number, windowMs: number }} limit
 */
export async function consume(key, limit) {
  const { count, window } = await increment(key, limit);
  if (count > limit.max) throw rateLimited(window.retryAfter);
}

/**
 * Throws 429 if the key already reached the limit, without counting.
 * @param {string} key
 * @param {{ max: number, windowMs: number }} limit
 */
export async function assertBelow(key, limit) {
  const window = windowOf(key, limit);
  const buckets = await collection('rateLimits');
  const bucket = await buckets.findOne({ _id: window.id }, { projection: { count: 1 } });
  if ((bucket?.count ?? 0) >= limit.max) throw rateLimited(window.retryAfter);
}

/**
 * Counts one failure without throwing; the next attempt is blocked by assertBelow.
 * @param {string} key
 * @param {{ windowMs: number }} limit
 */
export async function recordFailure(key, limit) {
  await increment(key, limit);
}

/** @param {string} key */
export async function clear(key) {
  const buckets = await collection('rateLimits');
  await buckets.deleteMany({ key });
}
