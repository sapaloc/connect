import pg from 'pg';
import { connectionConfig } from './connection.js';
import { migrate } from './migrate.js';

/**
 * Drops every app table (the whole `public` schema), then re-applies all migrations.
 * Callers must check APP_ENV first; this never runs on production.
 * @param {string} connectionString
 */
export async function resetSchema(connectionString) {
  const client = new pg.Client(connectionConfig(connectionString));
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
  await migrate(connectionString);
}
