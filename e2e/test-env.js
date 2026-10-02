import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const API_PORT = 3100;
export const WEB_PORT = 5180;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/**
 * Puts .env.test into process.env, over anything already set, so the API, the web app and the
 * database reset only ever see the throwaway test database. Never reads .env.
 */
export function useTestEnv() {
  const values = parseEnv(readFileSync(new URL('../.env.test', import.meta.url), 'utf8'));
  if (values.APP_ENV !== 'test') throw new Error('E2E tests need APP_ENV=test in .env.test');
  Object.assign(process.env, values);
}
