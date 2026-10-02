import { expect, test } from '@playwright/test';
import { expectAmounts, lookUpCode, openAs } from './support.js';

test('merchant issues a voucher, the counter redeems it and the amounts add up', async ({ browser }) => {
  const customer = `E2E guest ${Date.now()}`;
  const merchant = await openAs(browser, 'admin', '/console/vouchers');
  const form = merchant.page.locator('#voucher-issue');
  await form.getByText('Amount off (₫)').click();
  await form.locator('#v-value').fill('50000');
  await expect(form.locator('#v-value')).toHaveValue('50,000');
  await form.getByLabel('Customer name').fill(customer);
  await form.getByRole('button', { name: 'Issue vouchers' }).click();
  await expect(merchant.page.locator('#issue-message')).toHaveText('1 voucher issued.');
  const card = merchant.page.locator('#issue-result .vcard');
  await expect(card.locator('.vcard-discount')).toHaveText('₫50,000 off');
  const code = (await card.locator('.vcard-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const counter = await openAs(browser, 'staff', '/counter');
  await lookUpCode(counter.page, code);
  await counter.page.getByLabel('Bill total').fill('250000');
  await expect(counter.page.locator('#bill')).toHaveValue('250,000');
  await expectAmounts(counter.page.locator('#redeem-preview .amounts'), { bill: 250_000, discount: 50_000 });
  await counter.page.getByRole('button', { name: 'Confirm and redeem' }).click();
  await expect(counter.page.locator('.redeem-ok')).toHaveText('Voucher redeemed');
  await expectAmounts(counter.page.locator('.redeem-done .amounts'), { bill: 250_000, discount: 50_000 });

  await merchant.page.reload();
  const row = merchant.page.locator('#voucher-rows tr', { hasText: customer });
  await expect(row.locator('.pill')).toHaveText('Redeemed');

  await counter.page.getByRole('button', { name: 'Next customer' }).click();
  await lookUpCode(counter.page, code);
  await expect(counter.page.locator('.redeem .form-message')).toContainText('This voucher has been used. Used on');
  await merchant.context.close();
  await counter.context.close();
});
