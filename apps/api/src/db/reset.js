import { getDb } from './mongo.js';
import { setup } from './setup.js';

/** Deletes every collection of MONGODB_DB and recreates validators and indexes. */
export async function resetDatabase() {
  const db = await getDb();
  await db.dropDatabase();
  await setup(db);
}
