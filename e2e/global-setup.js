import { request } from '@playwright/test';
import { ACCOUNTS, authFile, freshIp } from './support.js';
import { useTestEnv, WEB_URL } from './test-env.js';

/**
 * Drops and reseeds the test database, then signs every seed account in once and saves its
 * session in e2e/.auth: sign-in is limited to 5 failures per account and 20 tries per IP.
 */
export default async function globalSetup() {
  useTestEnv();
  if (process.env.APP_ENV !== 'test') throw new Error('E2E tests need APP_ENV=test (see .env.test)');
  const { PASSWORD, resetDatabase } = await import('../apps/api/test/helpers.js');
  const { seedPartnerProfiles, seedPartners } = await import('../apps/api/src/db/seed-local.js');
  const { closeClient } = await import('../apps/api/src/db/mongo.js');
  try {
    await resetDatabase();
    await seedPartners(PASSWORD);
    await seedPartnerProfiles();
  } finally {
    await closeClient();
  }

  for (const [name, { email }] of Object.entries(ACCOUNTS)) {
    const api = await request.newContext({ baseURL: WEB_URL, extraHTTPHeaders: { 'x-forwarded-for': freshIp() } });
    const res = await api.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
    if (!res.ok()) throw new Error(`global-setup: sign-in failed for ${email} (${res.status()})`);
    await api.storageState({ path: authFile(/** @type {import('./support.js').AccountName} */ (name)) });
    await api.dispose();
  }
}
