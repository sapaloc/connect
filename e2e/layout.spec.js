import { expect, test } from '@playwright/test';
import { openAs } from './support.js';

/** Runs in the phone (390 × 844) and desktop (1280 × 800) projects. */
const PAGES = /** @type {const} */ ([
  ['admin', '/console/vouchers', 'Vouchers'],
  ['admin', '/console/partners', 'Partners'],
  ['staff', '/counter', 'Counter'],
  ['referrer', '/my', 'Partner'],
]);

for (const [account, path, title] of PAGES) {
  test(`${account} ${path}: frame fits the screen`, async ({ browser }, testInfo) => {
    const { context, page } = await openAs(browser, account, path);
    await expect(page.locator('.tb-title')).toHaveText(title);
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(0);

    const sidebar = page.locator('#sidebar');
    if (testInfo.project.name === 'desktop') {
      await expect(sidebar).toBeInViewport();
      await expect(page.locator('.tb-menu')).toBeHidden();
      await expect(page.locator('.bn')).toBeHidden();
      await expect(sidebar.locator('.sb-link.active')).toContainText(title);
    } else {
      await expect(sidebar).not.toBeInViewport();
      await page.locator('.tb-menu').click();
      await expect(sidebar).toBeInViewport();
      await expect(sidebar.locator('.sb-link.active')).toContainText(title);
      await page.keyboard.press('Escape');
      await expect(sidebar).not.toBeInViewport();
    }
    await context.close();
  });
}
