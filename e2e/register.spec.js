import { expect, test } from '@playwright/test';
import { newContext, openAs, signIn } from './support.js';

const RUN = Date.now().toString(36);
const NEW_PASSWORD = 'Lotus#Owner2026';
let serial = 0;

/** A business and admin email no other run or test uses. */
function uniqueApplicant() {
  serial += 1;
  const id = `${RUN}${serial}${test.info().project.name[0]}`;
  return { name: `E2E Spa ${id}`, email: `owner.${id}@e2e.local` };
}

/**
 * Fills and sends the Register form; the page must show it.
 * @param {import('@playwright/test').Page} page
 * @param {{ name: string, email: string }} applicant
 */
async function apply(page, { name, email }) {
  const form = page.locator('#register');
  await form.getByLabel('Business name').fill(name);
  await form.getByLabel('Phone').fill('0901 234 567');
  await form.getByLabel('Address').fill('12 Lê Lợi, Quận 1');
  await form.getByLabel('Full name').fill('Lan Owner');
  await form.getByLabel('Email', { exact: true }).fill(email);
  await form.getByLabel('Language').selectOption('en');
  await form.getByLabel(/I accept the MyConnect terms/).check();
  await form.getByRole('button', { name: 'Send application' }).click();
  await expect(page.getByRole('heading', { name: 'We received your application' })).toBeVisible();
}

/** @param {import('@playwright/test').Browser} browser @param {{ name: string, email: string }} applicant */
async function applyInNewBrowser(browser, applicant) {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto('/register');
  await apply(page, applicant);
  await context.close();
}

test.describe('register on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone only');

  test('tabs switch between Sign in and Register; /register opens Register', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/login');
    await expect(page.getByRole('tablist')).toBeVisible();
    const signInTab = page.getByRole('tab', { name: 'Sign in' });
    const registerTab = page.getByRole('tab', { name: 'Register' });
    await expect(signInTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#sign-in')).toBeVisible();
    await expect(page.locator('#register')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible();

    await registerTab.click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(registerTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#register')).toBeVisible();
    await expect(page.locator('#sign-in')).toBeHidden();

    await registerTab.press('ArrowLeft');
    await expect(signInTab).toBeFocused();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/register');
    await expect(page.getByRole('tab', { name: 'Register' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Register your business' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(0);
    await context.close();
  });

  test('checks the form, sends an application and shows that it was received', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/register');
    const form = page.locator('#register');
    await form.getByRole('button', { name: 'Send application' }).click();
    await expect(page.locator('#register-message')).toHaveText('Enter the business name.');
    await expect(form.getByLabel('Business name')).toBeFocused();

    const applicant = uniqueApplicant();
    await form.getByLabel('Business name').fill(applicant.name);
    await form.getByLabel('Full name').fill('Lan Owner');
    await form.getByLabel('Email', { exact: true }).fill(applicant.email);
    await form.getByRole('button', { name: 'Send application' }).click();
    await expect(page.locator('#register-message')).toHaveText('Accept the terms to send the application.');

    await page.goto('/register');
    await apply(page, applicant);
    await expect(page.getByText('No account is created yet.')).toBeVisible();

    await page.goto('/register');
    await page.locator('#register').getByLabel('Business name').fill(`${applicant.name} again`);
    await page.locator('#register').getByLabel('Full name').fill('Lan Owner');
    await page.locator('#register').getByLabel('Email', { exact: true }).fill(applicant.email);
    await page.locator('#register').getByLabel(/I accept the MyConnect terms/).check();
    await page.locator('#register').getByRole('button', { name: 'Send application' }).click();
    await expect(page.locator('#register-message')).toHaveText(
      'An application with this email or business name is already waiting for review.',
    );
    await context.close();
  });

  test('Platform admin approves; the new merchant admin must change the temporary password', async ({ browser }) => {
    const applicant = uniqueApplicant();
    await applyInNewBrowser(browser, applicant);

    const { context: adminContext, page: admin } = await openAs(browser, 'platform', '/console/merchants');
    const card = admin.locator('.application', { hasText: applicant.name });
    await expect(card).toContainText(applicant.email);
    await expect(admin.locator('#applications-count')).toBeVisible();
    await card.getByRole('button', { name: 'Approve' }).click();
    const dialog = admin.locator('dialog[open]');
    await expect(dialog.getByLabel('Merchant name')).toHaveValue(applicant.name);
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(dialog.getByRole('heading', { name: `${applicant.name} created` })).toBeVisible();
    await expect(dialog).toContainText(applicant.email);
    const temporaryPassword = await dialog.locator('.temp-password').inputValue();
    expect(temporaryPassword).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{16}$/);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(admin.locator('.application', { hasText: applicant.name })).toHaveCount(0);
    await expect(admin.locator('#merchant-rows tr', { hasText: applicant.name })).toContainText('Waiting for first sign-in');

    const ownerContext = await newContext(browser);
    const owner = await ownerContext.newPage();
    await signIn(owner, applicant.email, temporaryPassword);
    await expect(owner).toHaveURL(/\/change-password$/);
    await owner.goto('/console/partners');
    await expect(owner).toHaveURL(/\/change-password$/);
    await owner.getByLabel('Temporary password').fill(temporaryPassword);
    await owner.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await owner.getByLabel('Repeat password').fill(NEW_PASSWORD);
    await owner.getByRole('button', { name: 'Save and continue' }).click();
    await expect(owner).toHaveURL(/\/console$/);
    await expect(owner.locator('.tb-title')).toBeVisible();
    const me = await owner.evaluate(() => fetch('/api/v1/auth/me').then((res) => res.json()));
    expect(me.mustChangePassword).toBe(false);
    expect(me.activeRole.role).toBe('TENANT_ADMIN');
    expect(me.activeRole.tenantName).toBe(applicant.name);
    await ownerContext.close();

    await admin.reload();
    await expect(admin.locator('#merchant-rows tr', { hasText: applicant.name })).not.toContainText('Waiting for first sign-in');
    await adminContext.close();
  });

  test('Platform admin rejects with a reason', async ({ browser }) => {
    const applicant = uniqueApplicant();
    await applyInNewBrowser(browser, applicant);

    const { context, page } = await openAs(browser, 'platform', '/console/merchants');
    const card = page.locator('.application', { hasText: applicant.name });
    await card.getByRole('button', { name: 'Reject' }).click();
    const dialog = page.locator('dialog[open]');
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog.locator('#reject-message')).toHaveText('Enter a reason.');
    await dialog.getByLabel('Reason').fill('Not a spa business');
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#application-message')).toHaveText(
      `Application from ${applicant.name} rejected. Reason saved: “Not a spa business”.`,
    );
    await expect(page.locator('.application', { hasText: applicant.name })).toHaveCount(0);
    await context.close();
  });
});

test.describe('register on a desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('Sign in and Register sit side by side from 768 px, each half of the card', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    for (const viewport of [
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      for (const path of ['/login', '/register']) {
        await page.goto(path);
        await expect(page.getByRole('tablist'), `${viewport.width} ${path}`).toBeHidden();
        await expect(page.locator('#sign-in')).toBeVisible();
        await expect(page.locator('#register')).toBeVisible();
        const signInPane = await page.locator('#pane-signin').boundingBox();
        const registerPane = await page.locator('#pane-register').boundingBox();
        const panes = await page.locator('.auth-panes').boundingBox();
        const email = await page.locator('#email').boundingBox();
        const businessName = await page.locator('#r-name').boundingBox();
        if (!signInPane || !registerPane || !panes || !email || !businessName) throw new Error('panes not visible');
        expect(Math.abs(signInPane.y - registerPane.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(signInPane.width - registerPane.width)).toBeLessThanOrEqual(1);
        expect(registerPane.x).toBeGreaterThan(signInPane.x + signInPane.width);
        expect(signInPane.width / panes.width).toBeGreaterThan(0.4);
        expect(signInPane.width / panes.width).toBeLessThanOrEqual(0.5);
        expect(email.width, `${viewport.width} sign-in input`).toBeGreaterThanOrEqual(300);
        expect(businessName.width, `${viewport.width} register input`).toBeGreaterThanOrEqual(300);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${viewport.width} no horizontal scroll`).toBeLessThanOrEqual(0);
      }
    }
    await context.close();
  });
});
