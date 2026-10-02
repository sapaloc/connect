import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { WEB_URL } from './test-env.js';

/** Seed accounts (apps/api/src/db/seed-local.js) and the page each one lands on after sign-in. */
export const ACCOUNTS = /** @type {const} */ ({
  platform: { email: 'platform@connect.local', landing: '/console' },
  admin: { email: 'admin@number160.local', landing: '/console' },
  manager: { email: 'manager@number160.local', landing: '/console' },
  staff: { email: 'staff@number160.local', landing: '/counter' },
  restaurantAdmin: { email: 'admin@nhahang.local', landing: '/console' },
  referrer: { email: 'referrer@number160.local', landing: '/my' },
  driver: { email: 'taixe.demo@example.com', landing: '/my' },
  partner: { email: 'partner@number160.local', landing: '/my' },
});

/** @typedef {keyof typeof ACCOUNTS} AccountName */

/** @param {AccountName} name */
export function authFile(name) {
  return fileURLToPath(new URL(`.auth/${name}.json`, import.meta.url));
}

let ipCounter = 0;

/**
 * A client IP of its own (the API reads X-Forwarded-For), so per-IP limits such as 20 sign-ins
 * per 15 minutes never mix browsers of different tests.
 */
export function freshIp() {
  ipCounter += 1;
  return `10.${200 + (process.pid % 50)}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

/**
 * New browser context with its own IP; signed in with the session saved by global-setup when
 * `account` is given. `lang` is set before the app reads it.
 * @param {import('@playwright/test').Browser} browser
 * @param {{ account?: AccountName, lang?: 'en' | 'vi' }} [options]
 */
export async function newContext(browser, { account, lang } = {}) {
  const context = await browser.newContext({ storageState: account ? authFile(account) : undefined });
  const ip = freshIp();
  // Only on API calls: a custom header on cross-origin requests (Google Fonts) fails the CORS preflight.
  await context.route(`${WEB_URL}/api/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } }));
  if (lang) await context.addInitScript((value) => localStorage.setItem('connect.lang', value), lang);
  return context;
}

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {AccountName} account
 * @param {string} path
 * @param {{ lang?: 'en' | 'vi' }} [options]
 */
export async function openAs(browser, account, path, options = {}) {
  const context = await newContext(browser, { account, ...options });
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
}

/** Whole VND as the app shows it in English ("₫1,250,000"). @param {number} amount */
export function vnd(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount);
}

/** Digits of a shown amount ("− ₫50,000" → 50000). @param {string | null} text */
export function amountOf(text) {
  return Number((text ?? '').replace(/\D/g, ''));
}

/**
 * Checks a bill / discount / customer pays block: the shown numbers, that they add up, and that
 * "Customer pays" keeps at least 16 px from its amount. In a narrow box (`mayWrap`) the amount may
 * instead wrap below the label.
 * @param {import('@playwright/test').Locator} amounts a `dl.amounts`
 * @param {{ bill: number, discount: number }} expected
 * @param {{ mayWrap?: boolean }} [options]
 */
export async function expectAmounts(amounts, { bill, discount }, { mayWrap = false } = {}) {
  const values = await amounts.locator('dd').allTextContents();
  expect(values.map(amountOf)).toEqual([bill, discount, bill - discount]);
  expect(amountOf(values[0])).toBe(amountOf(values[1]) + amountOf(values[2]));
  const total = amounts.locator('.amounts-total');
  const dt = await total.locator('dt').boundingBox();
  const dd = await total.locator('dd').boundingBox();
  if (!dt || !dd) throw new Error('amounts-total is not visible');
  if (dd.y < dt.y + dt.height / 2) {
    expect(dd.x - (dt.x + dt.width)).toBeGreaterThanOrEqual(16);
  } else {
    expect(mayWrap, '"Customer pays" and its amount on one line').toBe(true);
    expect(dd.y).toBeGreaterThanOrEqual(dt.y + dt.height - 1);
  }
}

/** A redemption code as staff types it, from what the voucher card shows ("ABCD-2345"). @param {string} shown */
export function rawCode(shown) {
  return shown.replace(/[^A-Z0-9]/gi, '');
}

/**
 * Guest takes a voucher from a partner QR link in its own browser; returns the shown code.
 * @param {import('@playwright/test').Page} guest
 * @param {string} link
 */
export async function takeReferralVoucher(guest, link) {
  await guest.goto(link);
  await guest.getByRole('button', { name: 'Get voucher' }).click();
  await expect(guest).toHaveURL(/\/v\/[A-Z0-9]+$/);
  const code = (await guest.locator('.vcard-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  return code;
}

/**
 * Counter looks up a code and gets to the bill form.
 * @param {import('@playwright/test').Page} counter
 * @param {string} code
 */
export async function lookUpCode(counter, code) {
  await counter.getByLabel('Or type the voucher code').fill(rawCode(code));
  await counter.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(counter.locator('.redeem-code')).toHaveText(code);
}
