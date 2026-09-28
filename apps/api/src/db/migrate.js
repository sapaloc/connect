import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { env, requireEnv } from '../config/env.js';
import { connectionConfig } from './connection.js';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
const LOCK_KEY = 7_160_001;

/** @param {string} connectionString */
export async function migrate(connectionString) {
  const client = new pg.Client(connectionConfig(connectionString));
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`migrate: applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migrate: ${file} failed: ${error.message}`);
      }
    }
    console.log(`migrate: up to date (${files.length} files)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireEnv('databaseMigrationUrl');
  await migrate(env.databaseMigrationUrl);
}
