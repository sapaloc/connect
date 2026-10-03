import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { amountOf, lookUpCode, newContext, openAs, takeReferralVoucher, vnd } from './support.js';

const DRIVER = 'Tài xế Demo';
const DRIVER_COMMISSION = 70_000;

test('guest cannot confirm: staff records with a bill photo, merchant admin reviews XXXX-XXXX and approves', async ({ browser }) => {
  const admin = await openAs(browser, 'admin', '/console/partners');
  const { partners } = await (await admin.page.request.get('/api/v1/partners')).json();
  const driver = partners.find((/** @type {any} */ p) => p.name === DRIVER);
  const card = admin.page.locator(`#partner-${driver.id}`);
  const unpaid = card.locator('.partner-stat', { hasText: 'Commission unpaid' }).locator('dd');
  await expect(unpaid).toBeVisible();
  const unpaidBefore = amountOf(await unpaid.textContent());

  const guestContext = await newContext(browser);
  const code = await takeReferralVoucher(await guestContext.newPage(), `/r/${driver.qr.token}`);
  await guestContext.close();

  const counter = await openAs(browser, 'staff', '/counter');
  await lookUpCode(counter.page, code);
  await counter.page.getByLabel('Bill total').fill('300000');
  await counter.page.getByRole('button', { name: 'Send the bill to the guest' }).click();
  await counter.page.getByRole('button', { name: 'Guest cannot confirm' }).click();

  const fallback = counter.page.locator('#fallback-form');
  await fallback.getByLabel('Reason').selectOption('NEW_PHONE');
  await fallback.getByRole('button', { name: 'Record the redemption' }).click();
  await expect(counter.page.locator('#fallback-message')).toHaveText('Take a photo of the bill first.');
  const photo = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#F4F1EA' } }).jpeg().toBuffer();
  await fallback.locator('#fallback-bill-file').setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(fallback.locator('[data-bill-status]')).toHaveText('Bill photo added.');
  await fallback.getByRole('button', { name: 'Record the redemption' }).click();
  await expect(counter.page.locator('.redeem-ok')).toHaveText('Voucher redeemed');
  await expect(counter.page.getByText('Recorded. The merchant admin will check the bill photo.')).toBeVisible();
  await counter.context.close();

  await admin.page.reload();
  await expect(card.locator('.partner-pending')).toContainText('Waiting for review:');
  await card.getByRole('button', { name: 'Review bills' }).click();
  const dialog = admin.page.locator('dialog[open]');
  const item = dialog.locator('.review-item', { hasText: code });
  const shownCode = item.locator('strong.font-monospace');
  await expect(shownCode).toHaveText(code);
  await expect(shownCode).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await expect(item).toContainText(`Bill ${vnd(300_000)}`);
  await expect(item).toContainText(`Commission ${vnd(DRIVER_COMMISSION)}`);
  await expect(item.locator('.bill-photos img')).toHaveCount(1);

  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(dialog.locator('#review-message')).toHaveText('Approved: the commission is now unpaid commission.');
  await expect(item).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // report.spec.js may add a driver commission in a parallel worker.
  await expect.poll(async () => amountOf(await unpaid.textContent())).toBeGreaterThanOrEqual(unpaidBefore + DRIVER_COMMISSION);
  await expect(card.getByRole('button', { name: 'Mark as paid' })).toBeVisible();
  await admin.context.close();
});
