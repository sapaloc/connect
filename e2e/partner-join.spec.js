import { expect, request, test } from '@playwright/test';
import { authFile, freshIp, newContext, openAs, signIn, vnd } from './support.js';
import { WEB_URL } from './test-env.js';

const RUN = Date.now().toString(36);
const PASSWORD = 'Hotel#Join2026';
let serial = 0;

/** @param {import('@playwright/test').APIRequestContext} api @param {string} path @param {unknown} data */
async function postOk(api, path, data) {
  const res = await api.post(path, { data });
  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`);
  return res.json();
}

/**
 * A partner approved from the sign-in page with its own password and no merchant yet; set up through
 * the API so the test starts at Find merchants.
 */
async function approvedPartner() {
  serial += 1;
  const id = `${RUN}${serial}${test.info().project.name[0]}`;
  const partner = { name: `Join Hotel ${id}`, contact: `Mai Desk ${id}`, email: `join.${id}@e2e.local` };
  /** @param {{ storageState?: string }} [options] */
  const client = (options = {}) => request.newContext({ baseURL: WEB_URL, extraHTTPHeaders: { 'x-forwarded-for': freshIp() }, ...options });

  const anonymous = await client();
  const applied = await anonymous.post('/api/v1/partner-applications', {
    data: {
      relationshipKind: 'COMPANY',
      partnerType: 'HOTEL',
      name: partner.name,
      contactName: partner.contact,
      phone: '0903 444 555',
      email: partner.email,
      preferredLanguage: 'en',
      acceptTerms: true,
    },
  });
  expect(applied.status()).toBe(202);
  const platform = await client({ storageState: authFile('platform') });
  const { applications } = await (await platform.get('/api/v1/partner-applications')).json();
  const application = applications.find((/** @type {any} */ a) => a.email === partner.email);
  const approved = await postOk(platform, `/api/v1/partner-applications/${application.id}/approve`, {});
  const own = await client();
  await postOk(own, '/api/v1/auth/login', { email: partner.email, password: approved.temporaryPassword });
  await postOk(own, '/api/v1/auth/password/change', { currentPassword: approved.temporaryPassword, newPassword: PASSWORD });
  await Promise.all([anonymous.dispose(), platform.dispose(), own.dispose()]);
  return partner;
}

/** @param {import('@playwright/test').Page} page */
async function expectNoHorizontalScroll(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(0);
}

/**
 * The merchant admin turns "Accept new partners" on (Console → Brand).
 * @param {import('@playwright/test').Browser} browser
 * @param {'admin' | 'restaurantAdmin'} [account]
 */
async function acceptNewPartners(browser, account = 'admin') {
  const merchant = account === 'admin' ? 'Number160' : 'Nhà hàng Demo';
  const { context, page } = await openAs(browser, account, '/console/brand');
  const toggle = page.getByRole('switch', { name: 'Accept new partners' });
  await expect(toggle).toBeEnabled();
  if (!(await toggle.isChecked())) {
    await toggle.click();
    await expect(page.locator('#accept-message')).toHaveText(`On: partners can find ${merchant} and send requests.`);
  }
  await expect(toggle).toBeChecked();
  await expectNoHorizontalScroll(page);
  await context.close();
}

test('merchant accepts new partners; a partner finds it and asks; the admin approves with terms; the partner gets its QR', async ({ browser }) => {
  await acceptNewPartners(browser);
  const partner = await approvedPartner();

  const partnerContext = await newContext(browser);
  const page = await partnerContext.newPage();
  await signIn(page, partner.email, PASSWORD);
  await expect(page).toHaveURL(/\/partner\/welcome$/);
  await page.getByRole('link', { name: 'Find merchants' }).click();
  await expect(page).toHaveURL(/\/my\/merchants$/);
  await expect(page.getByRole('heading', { name: 'Find merchants', level: 1 })).toBeVisible();
  await page.getByPlaceholder('Search by name').fill('number');
  const card = page.locator('.fm-merchant', { hasText: 'Number160' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Ask to join' }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.getByRole('heading', { name: 'Ask Number160 to work with you' })).toBeVisible();
  await dialog.getByLabel(/Message/).fill('We send about 20 guests a week.');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(page.locator('#fm-message')).toHaveText('Request sent to Number160. You will get an email when the merchant answers.');
  await expect(card.getByText('Requested', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cancel request' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  const { context: adminContext, page: admin } = await openAs(browser, 'admin', '/console/partners');
  const joinCard = admin.locator('#join-card');
  await expect(joinCard).toBeVisible();
  const request = joinCard.locator('.join-card', { hasText: partner.name });
  await expect(request).toContainText('Hotel · Company');
  await expect(request).toContainText(partner.email);
  await expect(request).toContainText('Message: We send about 20 guests a week.');
  await expectNoHorizontalScroll(admin);
  await request.getByRole('button', { name: 'Approve' }).click();

  const form = admin.locator('#partner-create-card');
  await expect(form.getByRole('heading', { name: `Approve ${partner.name}` })).toBeVisible();
  await expect(form.getByLabel('Partner name')).toHaveValue(partner.name);
  await expect(form.getByLabel(/Contact email/)).toHaveValue(partner.email);
  await expect(form.getByLabel(/Contact person/)).toHaveValue(partner.contact);
  await expect(form.locator('#p-kind-COMPANY')).toBeChecked();
  await expect(form.locator('#p-account')).toBeHidden();
  await expect(form.locator('#p-join-account')).toHaveText(`MyConnect account: ${partner.email} (existing account, no new password)`);
  await form.getByLabel('Guest discount (VND)').fill('80000');
  await form.getByLabel('Partner commission (VND)').fill('120000');
  await expectNoHorizontalScroll(admin);
  await form.getByRole('button', { name: 'Approve and add partner' }).click();
  await expect(admin.locator('#partner-message')).toContainText(`${partner.name} is now a partner.`);
  await expect(admin.locator('.partner-card', { hasText: partner.name })).toContainText(partner.email);
  await expect(admin.locator('#join-card .join-card', { hasText: partner.name })).toHaveCount(0);
  await adminContext.close();

  await page.getByPlaceholder('Search by name').fill('number160');
  await expect(card.getByText('Already a partner')).toBeVisible();
  await expect(page.locator('#fm-joined')).toContainText('You are now a partner of Number160.');

  // Reloading picks up the only role: no "Choose a merchant" screen, no new sign-in.
  await page.reload();
  await expect(page).toHaveURL(/\/my\/merchants$/);
  await expect(page.getByRole('heading', { name: 'Choose a merchant' })).toHaveCount(0);
  const merchantCard = page.locator('.fm-merchant', { hasText: 'Number160' });
  await expect(merchantCard.getByText('Already a partner')).toBeVisible();
  await expect(page.locator('#fm-joined')).toBeHidden();
  const nav = test.info().project.name === 'phone' ? page.locator('.bn') : page.locator('#sidebar');
  await nav.getByRole('link', { name: 'Partner', exact: true }).click();
  await expect(page).toHaveURL(/\/my$/);
  await expect(page.locator('.my-page .eyebrow').first()).toHaveText('Number160');
  await expect(page.locator('.my-page h2').first()).toHaveText(partner.name);
  await expect(page.locator('.my-page')).toContainText(`Guests get ${vnd(80000)} off · you earn ${vnd(120000)} per bill.`);
  await expect(page.locator('#my-qr')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await partnerContext.close();

  const again = await newContext(browser);
  const fresh = await again.newPage();
  await signIn(fresh, partner.email, PASSWORD);
  await expect(fresh).toHaveURL(/\/my$/);
  await expect(fresh.locator('.my-page .eyebrow').first()).toHaveText('Number160');
  await again.close();
});

test('a partner with merchants finds more from MyConnect; the Manager sees requests but cannot approve', async ({ browser }) => {
  await acceptNewPartners(browser);
  const partner = await approvedPartner();
  const partnerContext = await newContext(browser);
  const page = await partnerContext.newPage();
  await signIn(page, partner.email, PASSWORD);
  await expect(page).toHaveURL(/\/partner\/welcome$/);
  await page.goto('/my/merchants');
  await page.locator('.fm-merchant', { hasText: 'Number160' }).getByRole('button', { name: 'Ask to join' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Send request' }).click();
  await expect(page.locator('#fm-message')).toContainText('Request sent to Number160.');

  const { context: managerContext, page: manager } = await openAs(browser, 'manager', '/console/partners');
  const request = manager.locator('#join-card .join-card', { hasText: partner.name });
  await expect(request).toBeVisible();
  await expect(manager.locator('#join-card')).toContainText('Only the Merchant admin can approve or reject.');
  await expect(request.getByRole('button')).toHaveCount(0);
  await managerContext.close();

  page.once('dialog', (confirm) => confirm.accept());
  await page.locator('.fm-merchant', { hasText: 'Number160' }).getByRole('button', { name: 'Cancel request' }).click();
  await expect(page.locator('#fm-message')).toHaveText('Request to Number160 cancelled.');
  await expect(page.locator('.fm-merchant', { hasText: 'Number160' }).getByRole('button', { name: 'Ask to join' })).toBeVisible();
  await partnerContext.close();
});

test('a partner added by a merchant finds another merchant from MyConnect and asks to join', async ({ browser }) => {
  await acceptNewPartners(browser, 'restaurantAdmin');
  const isPhone = test.info().project.name === 'phone';
  // Merchant-created seed partners of Number160 only; one per project so both can run at once.
  const account = isPhone ? 'referrer' : 'driver';
  const profileName = isPhone ? 'Hướng dẫn viên Demo' : 'Tài xế Demo';
  const { context, page } = await openAs(browser, account, '/my');
  const nav = isPhone ? page.locator('.bn') : page.locator('#sidebar');
  await nav.getByRole('link', { name: 'Find merchants' }).click();
  await expect(page).toHaveURL(/\/my\/merchants$/);
  await expect(page.locator('.tb-title')).toHaveText('Find merchants');
  await expect(page.locator('.fm-merchant', { hasText: 'Number160' })).toContainText('Already a partner');
  const restaurant = page.locator('.fm-merchant', { hasText: 'Nhà hàng Demo' });
  await restaurant.getByRole('button', { name: 'Ask to join' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Send request' }).click();
  await expect(page.locator('#fm-message')).toContainText('Request sent to Nhà hàng Demo.');
  await expect(restaurant.getByText('Requested', { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);

  const admin = await openAs(browser, 'restaurantAdmin', '/console/partners');
  const request = admin.page.locator('#join-card .join-card', { hasText: profileName });
  await expect(request).toBeVisible();
  await expect(request.getByRole('button', { name: 'Approve' })).toBeVisible();
  await admin.context.close();

  page.once('dialog', (confirm) => confirm.accept());
  await restaurant.getByRole('button', { name: 'Cancel request' }).click();
  await expect(page.locator('#fm-message')).toHaveText('Request to Nhà hàng Demo cancelled.');
  await context.close();
});
