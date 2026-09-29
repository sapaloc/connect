import { MongoClient } from 'mongodb';
import { env, requireEnv } from '../config/env.js';

export const COLLECTIONS = Object.freeze({
  tenants: 'tenants',
  users: 'users',
  sessions: 'sessions',
  invitations: 'invitations',
  passwordResets: 'password_resets',
  rateLimits: 'rate_limits',
  auditEvents: 'audit_events',
  vouchers: 'vouchers',
  schemaVersions: 'schema_versions',
});

/** @type {Promise<MongoClient> | undefined} */
let connecting;

/**
 * One client per process: warm serverless invocations reuse its connection pool
 * instead of opening new connections (Atlas M0 allows about 500).
 */
export function getClient() {
  if (!connecting) {
    requireEnv('mongodbUri');
    const client = new MongoClient(env.mongodbUri, {
      appName: 'connect',
      maxPoolSize: env.dbPoolMax,
      serverSelectionTimeoutMS: 5000,
    });
    connecting = client.connect().catch((error) => {
      connecting = undefined;
      throw error;
    });
  }
  return connecting;
}

export async function getDb() {
  return (await getClient()).db(env.mongodbDb);
}

/**
 * @template {import('mongodb').Document} [T=import('mongodb').Document]
 * @param {keyof typeof COLLECTIONS} name
 * @returns {Promise<import('mongodb').Collection<T>>}
 */
export async function collection(name) {
  return (await getDb()).collection(COLLECTIONS[name]);
}

export async function closeClient() {
  const pending = connecting;
  connecting = undefined;
  if (pending) await (await pending).close();
}
