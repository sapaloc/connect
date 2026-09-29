import { getClient } from './mongo.js';

/**
 * Runs `work` in a transaction (needs a replica set: Atlas, or local Docker with --replSet).
 * Pass `{ session }` to every read and write inside. The driver retries `work` on transient
 * write conflicts, so it must not have side effects outside the database.
 * @template T
 * @param {(session: import('mongodb').ClientSession) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withTransaction(work) {
  const session = (await getClient()).startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
}
