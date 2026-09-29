import { passwordPolicyErrors } from '#domain';
import http from 'node:http';
import pg from 'pg';
import { env } from '../src/config/env.js';
import { connectionConfig } from '../src/db/connection.js';
import { getPool } from '../src/db/pool.js';
import { resetSchema } from '../src/db/reset.js';
import { seed } from '../src/db/seed-local.js';
import { handle } from '../src/http/app.js';

export const PASSWORD = env.seedPassword;

/** Drops the test schema, migrates and seeds. Refuses to run outside APP_ENV=test. */
export async function resetDatabase() {
  if (env.appEnv !== 'test') throw new Error('Integration tests need APP_ENV=test (see .env.test)');
  if (passwordPolicyErrors(PASSWORD).length) throw new Error('SEED_PASSWORD in .env.test does not meet the password policy');
  await resetSchema(env.databaseMigrationUrl);
  const client = new pg.Client(connectionConfig(env.databaseMigrationUrl));
  await client.connect();
  try {
    await client.query('BEGIN');
    const tenantId = await seed(client, PASSWORD);
    await client.query('COMMIT');
    return tenantId;
  } finally {
    await client.end();
  }
}

export async function startServer() {
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await getPool().end();
    },
  };
}

let ipCounter = 1;

/** A browser-like client: keeps the session cookie; each agent has its own client IP. */
export class Agent {
  /** @param {string} baseUrl */
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
    this.ip = `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {Record<string, string>} [headers]
   */
  async request(method, path, body, headers = {}) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        'x-forwarded-for': this.ip,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, setCookie };
  }

  /** @param {string} path @param {unknown} [body] @param {Record<string, string>} [headers] */
  post(path, body = {}, headers) {
    return this.request('POST', path, body, headers);
  }

  /** @param {string} path */
  get(path) {
    return this.request('GET', path);
  }

  /** @param {string} email @param {string} [password] */
  login(email, password = PASSWORD) {
    return this.post('/api/v1/auth/login', { email, password });
  }
}

/** @param {string} url */
export function tokenFromLink(url) {
  return new URL(url).hash.slice(1);
}
