import { expect, test } from '@playwright/test';
import { newContext, openAs, signIn } from './support.js';

const RUN = Date.now().toString(36);
const NEW_PASSWORD = 'Hotel#Partner2026';
let serial = 0;

/** A partner name and email no other run or test uses. */
function uniquePartner() {
  serial += 1;
  const id = `${RUN}${serial}${test.info().project.name[0]}`;
  return { name: `E2E Hotel ${id}`, contact: `Lan Desk ${id}`, email: `desk.${id}@e2e.local` };
}

/**
 * Chooses Merchant or Partner above the Register form (radio buttons styled as a switch).
 * @param {import('@playwright/test').Page} page
 * @param {'Merchant' | 'Partner'} type
 */
async function chooseType(page, type) {
  await page.locator('.register-type label', { hasText: type }).click();
}

/**
 * Fills and sends the Partner form, which must be showing.
 * @param {import('@playwright/test').Page} page
 * @param {{ name: string, contact: string, email: string }} partner
 */
async function applyAsPartner(page, { name, contact, email }) {
  const form = page.locator('#partner-register');
  await form.getByLabel('Partner type').selectOption('HOTEL');
  await form.getByLabel('Business name').fill(name);
  await form.getByLabel('Contact person').fill(contact);
  await form.getByLabel('Phone').fill('0903 111 222');
  await form.getByLabel('Email', { exact: true }).fill(email);
  await form.getByLabel('Language').selectOption('en');
  await form.getByLabel('Note').fill('District 1, 40 rooms');
  await form.getByLabel(/I accept the MyConnect terms/).check();
  await form.getByRole('button', { name: 'Send application' }).click();
  await expect(page.getByRole('heading', { name: 'We received your application' })).toBeVisible();
}

test.describe('partner register on a desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('the Register column has a Merchant | Partner switch, Merchant first; the columns stay side by side', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/login');
      const pane = page.locator('#pane-register');
      const group = pane.getByRole('radiogroup', { name: 'Register as' });
      await expect(group, `${viewport.width}`).toBeVisible();
      await expect(group.getByRole('radio', { name: 'Merchant' })).toBeChecked();
      await expect(page.locator('#register')).toBeVisible();
      await expect(page.locator('#partner-register')).toBeHidden();

      await chooseType(page, 'Partner');
      await expect(group.getByRole('radio', { name: 'Partner' })).toBeChecked();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('heading', { name: 'Become a partner' })).toBeVisible();
      await expect(page.locator('#partner-register')).toBeVisible();
      await expect(page.locator('#register')).toBeHidden();
      await expect(page.locator('#sign-in')).toBeVisible();

      const signInPane = await page.locator('#pane-signin').boundingBox();
      const registerPane = await pane.boundingBox();
      const name = await page.locator('#pr-name').boundingBox();
      if (!signInPane || !registerPane || !name) throw new Error('panes not visible');
      expect(Math.abs(signInPane.y - registerPane.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(signInPane.width - registerPane.width)).toBeLessThanOrEqual(1);
      expect(registerPane.x).toBeGreaterThan(signInPane.x + signInPane.width);
      expect(name.width, `${viewport.width} partner input`).toBeGreaterThanOrEqual(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${viewport.width} no horizontal scroll`).toBeLessThanOrEqual(0);

      await chooseType(page, 'Merchant');
      await expect(page.locator('#register')).toBeVisible();
    }
    await context.close();
  });

  test('/register?type=partner opens the Partner form; switching updates the address', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/register?type=partner');
    await expect(page.locator('#partner-register')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Partner' })).toBeChecked();
    await chooseType(page, 'Merchant');
    await expect(page).toHaveURL(/\/register$/);
    await chooseType(page, 'Partner');
    await expect(page).toHaveURL(/\/register\?type=partner$/);
    await context.close();
  });
});

test.describe('partner register on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone only');

  test('Register tab → Partner → checks the form, sends the application, shows it was received', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByRole('tab', { name: 'Register' }).click();
    await expect(page).toHaveURL(/\/register$/);
    await chooseType(page, 'Partner');
    await expect(page).toHaveURL(/\/register\?type=partner$/);
    const form = page.locator('#partner-register');
    await expect(form).toBeVisible();

    await form.getByRole('button', { name: 'Send application' }).click();
    await expect(page.locator('#partner-register-message')).toHaveText('Enter the name.');
    await form.getByLabel('Business name').fill('Company Without Contact');
    await form.getByRole('button', { name: 'Send application' }).click();
    await expect(page.locator('#partner-register-message')).toHaveText('Enter the contact person.');
    await expect(form.getByLabel('Contact person')).toBeFocused();

    await form.locator('label', { hasText: 'Individual' }).click();
    await expect(form.getByLabel('Contact person')).toBeHidden();
    await expect(form.getByLabel('Full name')).toBeVisible();
    await form.locator('label', { hasText: 'Company' }).click();

    await applyAsPartner(page, uniquePartner());
    await expect(page.getByText('No account is created yet.')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(0);
    await context.close();
  });

  test('/register?type=partner opens the Register tab with the Partner form', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/register?type=partner');
    await expect(page.getByRole('tab', { name: 'Register' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Become a partner' })).toBeVisible();
    await page.getByRole('tab', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole('tab', { name: 'Register' }).click();
    await expect(page).toHaveURL(/\/register\?type=partner$/);
    await context.close();
  });

  test('Platform admin approves a partner; the partner changes the password and lands on the welcome page', async ({ browser }) => {
    const partner = uniquePartner();
    const applicantContext = await newContext(browser);
    const applicant = await applicantContext.newPage();
    await applicant.goto('/register?type=partner');
    await applyAsPartner(applicant, partner);
    await applicantContext.close();

    const { context: adminContext, page: admin } = await openAs(browser, 'platform', '/console/merchants');
    const card = admin.locator('.application', { hasText: partner.name });
    await expect(card).toContainText('Partner');
    await admin.locator('.application-filter label', { hasText: 'Partners' }).click();
    await expect(admin.locator('.application[data-type="merchant"]')).toHaveCount(0);
    await expect(card).toContainText('Hotel · Company');
    await expect(card).toContainText(partner.email);
    await expect(card).toContainText('District 1, 40 rooms');
    await card.getByRole('button', { name: 'Approve' }).click();
    const dialog = admin.locator('dialog[open]');
    await expect(dialog).toContainText(partner.email);
    await expect(dialog.getByLabel('Merchant name')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(dialog.getByRole('heading', { name: 'Partner account created' })).toBeVisible();
    await expect(dialog.locator('[data-email-status]')).toHaveText(
      'Email not sent — copy the password and give it to the partner yourself (phone or in person).',
    );
    const temporaryPassword = await dialog.locator('.temp-password').inputValue();
    expect(temporaryPassword).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{16}$/);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(admin.locator('.application', { hasText: partner.name })).toHaveCount(0);
    await adminContext.close();

    const partnerContext = await newContext(browser);
    const page = await partnerContext.newPage();
    await signIn(page, partner.email, temporaryPassword);
    await expect(page).toHaveURL(/\/change-password$/);
    await page.goto('/partner/welcome');
    await expect(page).toHaveURL(/\/change-password$/);
    await page.getByLabel('Temporary password').fill(temporaryPassword);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Repeat password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Save and continue' }).click();

    await expect(page).toHaveURL(/\/partner\/welcome$/);
    await expect(page.getByRole('heading', { name: `Welcome, ${partner.contact}` })).toBeVisible();
    await expect(page.locator('#partner-profile')).toContainText(partner.name);
    await expect(page.getByRole('button', { name: 'Find merchants' })).toBeDisabled();
    await expect(page.getByText('Coming soon')).toBeVisible();

    await page.getByRole('button', { name: 'Edit contact' }).click();
    await page.locator('#partner-contact').getByLabel('Phone').fill('0909 000 111');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#profile-message')).toHaveText('Contact details saved.');
    await expect(page.locator('#partner-profile')).toContainText('0909 000 111');

    await page.goto('/console');
    await expect(page).toHaveURL(/\/partner\/welcome$/);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/partner\/welcome$/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(0);
    await page.getByRole('link', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await partnerContext.close();
  });
});
