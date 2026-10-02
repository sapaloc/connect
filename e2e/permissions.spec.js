import { expect, test } from '@playwright/test';
import { openAs } from './support.js';

test.describe('permissions', () => {
  test('Manager sees partners but no commission screens', async ({ browser }) => {
    const { context, page } = await openAs(browser, 'manager', '/console/partners');
    const cards = page.locator('.partner-card');
    await expect(cards.first()).toBeVisible();
    await expect(page.locator('.partner-stats').first()).toContainText('Redemptions');
    for (const text of ['Commission unpaid', 'Commission paid', 'Mark as paid', 'Review bills', 'History', 'Edit rule']) {
      await expect(page.getByText(text, { exact: true }), text).toHaveCount(0);
    }
    await expect(page.locator('.partner-stat.is-money')).toHaveCount(0);

    const { partners } = await (await page.request.get('/api/v1/partners')).json();
    expect(partners.length).toBeGreaterThan(0);
    for (const partner of partners) expect(partner.stats.commissionOpen).toBeUndefined();
    const id = partners[0].id;
    expect((await page.request.get('/api/v1/commission-reviews')).status()).toBe(403);
    expect((await page.request.get(`/api/v1/partners/${id}/history`)).status()).toBe(403);
    expect((await page.request.post(`/api/v1/partners/${id}/payouts`, { data: {} })).status()).toBe(403);
    await context.close();
  });

  test("another merchant's partner is not found", async ({ browser }) => {
    const platform = await openAs(browser, 'platform', '/console/partners');
    const { partners } = await (await platform.page.request.get('/api/v1/partners')).json();
    const other = partners.find((/** @type {any} */ p) => p.merchantName === 'Nhà hàng Demo');
    expect(other, 'partner of the second merchant').toBeTruthy();
    await platform.context.close();

    const { context, page } = await openAs(browser, 'admin', `/console/partners?partner=${other.id}`);
    await expect(page.locator('.partner-card').first()).toBeVisible();
    await expect(page.locator(`#partner-${other.id}`)).toHaveCount(0);
    await expect(page.locator('.partner-card.is-target')).toHaveCount(0);

    const history = await page.request.get(`/api/v1/partners/${other.id}/history`);
    expect(history.status()).toBe(404);
    expect((await history.json()).error.code).toBe('PARTNER_NOT_FOUND');
    const status = await page.request.post(`/api/v1/partners/${other.id}/status`, { data: { status: 'PAUSED', reason: 'e2e' } });
    expect(status.status()).toBe(404);
    const reviews = await (await page.request.get(`/api/v1/commission-reviews?partnerId=${other.id}`)).json();
    expect(reviews.reviews).toEqual([]);
    await context.close();
  });
});
