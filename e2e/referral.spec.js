import { expect, test } from '@playwright/test';
import { expectAmounts, lookUpCode, newContext, openAs, takeReferralVoucher } from './support.js';

test('partner QR link → guest takes a voucher → counter sends the bill → guest confirms', async ({ browser }) => {
  const partner = await openAs(browser, 'referrer', '/my');
  const link = await partner.page.locator('.partner-qr-link').getAttribute('title');
  expect(link).toMatch(/^http:\/\/localhost:\d+\/r\/[A-Za-z0-9_-]+$/);
  await partner.context.close();

  const guestContext = await newContext(browser);
  const guest = await guestContext.newPage();
  await guest.goto(/** @type {string} */ (link));
  await expect(guest.locator('.vcard-eyebrow')).toHaveText('Referral offer');
  await expect(guest.locator('.vcard-customer')).toHaveText('Introduced by Hướng dẫn viên Demo');
  const code = await takeReferralVoucher(guest, /** @type {string} */ (link));
  await expect(guest.locator('.vcard-discount')).toHaveText('₫50,000 off');
  await guest.goto(/** @type {string} */ (link));
  await expect(guest).toHaveURL(new RegExp(`/v/${code.replace('-', '')}$`));
  await expect(guest.locator('.vcard-code')).toHaveText(code);

  const counter = await openAs(browser, 'staff', '/counter');
  await lookUpCode(counter.page, code);
  await counter.page.getByLabel('Bill total').fill('500000');
  await expectAmounts(counter.page.locator('#redeem-preview .amounts'), { bill: 500_000, discount: 50_000 });
  await counter.page.getByRole('button', { name: 'Send the bill to the guest' }).click();
  await expect(counter.page.locator('[data-wait-title]')).toHaveText('Waiting for the guest to confirm');

  const ask = guest.getByRole('alertdialog');
  await expect(ask.locator('#guest-confirm-title')).toHaveText('Confirm your bill at Number160');
  await expectAmounts(ask.locator('.amounts'), { bill: 500_000, discount: 50_000 }, { mayWrap: true });
  await ask.getByRole('button', { name: 'Correct, confirm' }).click();
  await expect(guest.getByText('Thank you! The voucher is applied to this bill.')).toBeVisible();
  await expect(guest.locator('.vcard .pill')).toHaveText('Redeemed');

  await expect(counter.page.locator('.redeem-ok')).toHaveText('Voucher redeemed');
  await expect(counter.page.getByText('The guest confirmed the bill.')).toBeVisible();
  await expectAmounts(counter.page.locator('.redeem-done .amounts'), { bill: 500_000, discount: 50_000 });

  await guestContext.close();
  await counter.context.close();
});
