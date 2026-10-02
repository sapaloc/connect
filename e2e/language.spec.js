import { expect, test } from '@playwright/test';
import { newContext, openAs } from './support.js';

test.describe('language switch', () => {
  test('sign-in page switches EN ↔ VI and keeps the page', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page.getByRole('button', { name: 'VI', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Đăng nhập' })).toBeVisible();
    await expect(page.getByText('Quên mật khẩu?')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Đăng nhập' })).toBeVisible();

    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await context.close();
  });

  test('signed-in page switches EN ↔ VI from the menu and keeps the page', async ({ browser }) => {
    const { context, page } = await openAs(browser, 'admin', '/console/vouchers');
    await expect(page.locator('.tb-title')).toHaveText('Vouchers');
    await expect(page.getByRole('heading', { name: 'Issue vouchers' })).toBeVisible();

    const toggle = async () => {
      if (await page.locator('.tb-menu').isVisible()) await page.locator('.tb-menu').click();
      await page.locator('.sb-action[data-lang]').click();
    };

    await toggle();
    await expect(page).toHaveURL(/\/console\/vouchers$/);
    await expect(page.locator('.tb-title')).toHaveText('Voucher');
    await expect(page.getByRole('heading', { name: 'Tạo voucher' })).toBeVisible();
    await expect(page.locator('.sb-action[data-lang]')).toContainText('Ngôn ngữ: VI');

    await toggle();
    await expect(page).toHaveURL(/\/console\/vouchers$/);
    await expect(page.locator('.tb-title')).toHaveText('Vouchers');
    await expect(page.getByRole('heading', { name: 'Issue vouchers' })).toBeVisible();
    await context.close();
  });
});
