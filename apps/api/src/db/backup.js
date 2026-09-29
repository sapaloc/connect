import { BSON } from 'mongodb';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { env } from '../config/env.js';
import { COLLECTIONS } from './mongo.js';
import { setup } from './setup.js';

const { EJSON } = BSON;

/** Recreated by signing in again; not worth restoring. */
const SKIPPED = new Set([COLLECTIONS.sessions, COLLECTIONS.rateLimits]);

export const BACKUP_KEEP = 30;

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
 * Writes a backup file into `dir` and keeps only the newest `keep` backups of this APP_ENV there.
 * @param {import('mongodb').Db} db
 * @param {string} dir
 * @param {number} [keep]
 */
export async function writeBackup(db, dir, keep = BACKUP_KEEP) {
  const backup = await exportDatabase(db);
  await mkdir(dir, { recursive: true });
  const file = join(dir, backup.fileName);
  await writeFile(file, backup.body, { mode: 0o600 });
  const prefix = `connect-${env.appEnv}-`;
  const existing = (await readdir(dir)).filter((name) => name.startsWith(prefix) && name.endsWith('.json.gz')).sort();
  const expired = existing.slice(0, Math.max(0, existing.length - keep));
  await Promise.all(expired.map((name) => rm(join(dir, name), { force: true })));
  return { file, bytes: backup.body.length, counts: backup.counts, removed: expired.length };
}
