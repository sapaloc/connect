import { BSON } from 'mongodb';
import { gunzipSync, gzipSync } from 'node:zlib';
import { env } from '../config/env.js';
import { getStorage } from '../storage/storage.js';
import { COLLECTIONS } from './mongo.js';
import { setup } from './setup.js';

const { EJSON } = BSON;

/** Recreated by signing in again; not worth restoring. */
const SKIPPED = new Set([COLLECTIONS.sessions, COLLECTIONS.rateLimits]);

export const BACKUP_KEEP = 30;
export const backupPrefix = () => `backups/${env.appEnv}/`;

/**
 * Every collection as canonical Extended JSON (keeps Decimal128, dates, binary exactly), gzipped.
 * @param {import('mongodb').Db} db
 */
export async function exportDatabase(db) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((collection) => collection.name)
    .filter((name) => !SKIPPED.has(name) && !name.startsWith('system.'))
    .sort();
  /** @type {Record<string, import('mongodb').Document[]>} */
  const collections = {};
  for (const name of names) collections[name] = await db.collection(name).find().sort({ _id: 1 }).toArray();
  const createdAt = new Date();
  const payload = { format: 'connect-backup/1', appEnv: env.appEnv, database: db.databaseName, createdAt, collections };
  const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
  return {
    fileName: `connect-${env.appEnv}-${stamp}.json.gz`,
    body: gzipSync(EJSON.stringify(payload, { relaxed: false })),
    counts: Object.fromEntries(names.map((name) => [name, collections[name].length])),
  };
}

/**
 * Replaces the whole database with the backup, then re-applies validators and indexes.
 * @param {import('mongodb').Db} db
 * @param {Buffer} body gzipped backup from exportDatabase
 */
export async function restoreDatabase(db, body) {
  const payload = EJSON.parse(gunzipSync(body).toString('utf8'), { relaxed: false });
  if (payload.format !== 'connect-backup/1') throw new Error('Not a Connect backup file');
  await db.dropDatabase();
  await setup(db);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [name, documents] of Object.entries(payload.collections)) {
    if (name === COLLECTIONS.schemaVersions) continue;
    if (documents.length) await db.collection(name).insertMany(documents, { ordered: true });
    counts[name] = documents.length;
  }
  return { createdAt: payload.createdAt, counts };
}

/**
 * Uploads today's backup to private storage and keeps only the newest BACKUP_KEEP files.
 * @param {import('mongodb').Db} db
 */
export async function runBackupJob(db) {
  const storage = getStorage();
  const backup = await exportDatabase(db);
  const path = `${backupPrefix()}${backup.fileName}`;
  await storage.put(path, backup.body, 'application/gzip');
  const existing = (await storage.list(backupPrefix())).filter((file) => file.endsWith('.json.gz')).sort();
  const expired = existing.slice(0, Math.max(0, existing.length - BACKUP_KEEP));
  await storage.remove(expired);
  return { path, bytes: backup.body.length, counts: backup.counts, removed: expired.length };
}
