import { expect, test } from '@playwright/test';
import { ACCOUNTS, newContext } from './support.js';

const PASSWORD = /** @type {string} */ (process.env.SEED_PASSWORD);

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} email
 * @param {string} password
 */
async function signIn(page, email, password) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('sign in', () => {
  for (const [name, { email, landing }] of Object.entries(ACCOUNTS)) {
    if (name === 'partner') continue;
    test(`${name} lands on ${landing}`, async ({ browser }) => {
      const context = await newContext(browser);
      const page = await context.newPage();
      await signIn(page, email, PASSWORD);
      await expect(page).toHaveURL(new RegExp(`${landing}$`));
      await expect(page.locator('.tb-title')).toBeVisible();
      await context.close();
    });
  }

  test('partner of two merchants chooses a merchant, then lands on /my', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, ACCOUNTS.partner.email, PASSWORD);
    await expect(page).toHaveURL(/\/select-role$/);
    await expect(page.getByRole('heading', { name: 'Choose a merchant' })).toBeVisible();
    await page.getByRole('button', { name: /Number160/ }).click();
    await expect(page).toHaveURL(/\/my$/);
    await expect(page.locator('.my-page h2')).toHaveText('Khách sạn Demo');
    await context.close();
  });

  test('wrong password shows the error and stays on sign-in', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, ACCOUNTS.staff.email, 'Wrong#Pass2026');
    await expect(page.locator('#form-message')).toHaveText('Email or password is incorrect.');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#password')).toHaveValue('');
    await context.close();
  });
});
