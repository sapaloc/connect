import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { freshIp, newContext, openAs, takeReferralVoucher } from './support.js';

const DRIVER = 'Tài xế Demo';
const MERCHANT_HEADER = 'date,voucher_code,partner,bill,guest_paid,commission,commission_status,paid_date,payout_note';
const PARTNER_HEADER = 'date,guest_paid,commission,commission_status,paid_date,payout_note';
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;

/** @type {string} */
let code = '';

/** @param {import('@playwright/test').Download} download */
async function csvLines(download) {
  const bytes = await readFile(await download.path());
  expect([...bytes.subarray(0, 3)], 'UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
  const lines = bytes.toString('utf8').slice(1).split('\r\n');
  return lines.map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1]).join(','));
}

/** @param {import('@playwright/test').Page} page */
async function noHorizontalScroll(page) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'no horizontal scroll').toBeLessThanOrEqual(0);
}

test.beforeAll(async ({ browser }) => {
  const admin = await openAs(browser, 'admin', '/console');
  const { partners } = await (await admin.page.request.get('/api/v1/partners')).json();
  const driver = partners.find((/** @type {any} */ p) => p.name === DRIVER);
  await admin.context.close();

  const guestContext = await newContext(browser);
  const guest = await guestContext.newPage();
  code = await takeReferralVoucher(guest, `/r/${driver.qr.token}`);
  const staff = await newContext(browser, { account: 'staff' });
  const sent = await staff.request.post(`/api/v1/vouchers/${code.replace('-', '')}/confirmations`, {
    data: { grossAmount: '400000' },
    headers: { 'x-forwarded-for': freshIp() },
  });
  expect(sent.status()).toBe(201);
  await guest.getByRole('alertdialog').getByRole('button', { name: 'Correct, confirm' }).click();
  await expect(guest.locator('.vcard .pill')).toHaveText('Redeemed');
  await staff.close();
  await guestContext.close();
});

test('merchant admin opens the report, switches period and exports a CSV with voucher codes', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'admin', '/console/partners');
  await page.getByRole('button', { name: 'Report' }).click();
  const card = page.locator('#partner-report-card');
  await expect(card.getByRole('heading', { name: 'Commission report' })).toBeVisible();
  const row = card.locator('.report-table tbody tr', { hasText: DRIVER });
  await expect(row).toBeVisible();
  await expect(row.locator('td.is-count')).not.toHaveText('0');
  await expect(card.locator('.report-table tfoot')).toContainText('Total');
  await noHorizontalScroll(page);

  await card.getByText('Last month', { exact: true }).click();
  await expect(card.locator('#rp-table')).toHaveText('No partner bill in this period.');

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  await card.getByText('Custom', { exact: true }).click();
  await card.getByLabel('From', { exact: true }).fill(today);
  await card.getByLabel('To', { exact: true }).fill(today);
  await expect(row).toBeVisible();
  await noHorizontalScroll(page);

  await card.getByText('This month', { exact: true }).click();
  await expect(row).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^commission-\d{4}-\d{2}-01_\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = await csvLines(download);
  expect(lines[0]).toBe(MERCHANT_HEADER);
  const bill = lines.find((line) => line.includes(code));
  expect(bill, `row of ${code}`).toBeTruthy();
  expect(bill?.split(',')[1]).toMatch(new RegExp(`^${CODE.source}$`));
  expect(bill).toContain(`${DRIVER},400000.0000,350000.0000,70000.0000,UNPAID`);
  await expect(card.locator('#rp-message')).toHaveText('CSV downloaded.');
  await context.close();
});

test('partner downloads its own CSV from MyConnect, without voucher codes', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'driver', '/my');
  const card = page.locator('#my-report');
  await expect(card.getByRole('heading', { name: 'Download report' })).toBeVisible();
  await noHorizontalScroll(page);
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: 'Download CSV' }).click()]);
  const lines = await csvLines(download);
  expect(lines[0]).toBe(PARTNER_HEADER);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.some((line) => line.includes('350000.0000,70000.0000,UNPAID'))).toBe(true);
  for (const line of lines) {
    expect(line).not.toMatch(CODE);
    expect(line).not.toContain(code.replace('-', ''));
  }
  await context.close();
});

test('Manager has no report', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'manager', '/console/partners?view=report');
  await expect(page.locator('.partner-card').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Report' })).toHaveCount(0);
  await expect(page.locator('#partner-report-card')).toHaveCount(0);
  expect((await page.request.get('/api/v1/reports/commission')).status()).toBe(403);
  expect((await page.request.get('/api/v1/reports/commission/csv')).status()).toBe(403);
  await context.close();
});
