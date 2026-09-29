import pg from 'pg';
import { env, requireEnv } from '../config/env.js';
import { connectionConfig } from './connection.js';

/** @type {pg.Pool | undefined} */
let pool;

export function getPool() {
  if (!pool) {
    requireEnv('databaseUrl');
    pool = new pg.Pool({
      ...connectionConfig(env.databaseUrl),
      max: env.dbPoolMax,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}
