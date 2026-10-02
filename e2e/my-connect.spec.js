import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openAs } from './support.js';

const LABELS = {
  en: ['Link opens', 'Vouchers taken', 'Redemptions'],
  vi: ['Lượt mở link', 'Lượt nhận', 'Lượt dùng'],
};
const DOWNLOAD = { en: 'Download image', vi: 'Tải ảnh' };

/**
 * Opens MyConnect in a fresh context in `lang`, checks the stats labels and downloads the QR poster.
 * @param {import('@playwright/test').Browser} browser
 * @param {'en' | 'vi'} lang
 */
async function posterFrom(browser, lang) {
  const { context, page } = await openAs(browser, 'referrer', '/my', { lang });
  expect(page.viewportSize()?.width).toBe(390);
  const labels = page.locator('.grid-kpi-3 .kpi-label');
  await expect(labels).toHaveText(LABELS[lang]);
  await page.evaluate(() => document.fonts.ready);
  const lines = await labels.evaluateAll((elements) =>
    elements.map((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    }),
  );
  expect(lines, `${lang} stats labels on one line`).toEqual([1, 1, 1]);

  await expect(page.locator('#my-qr')).toHaveAttribute('src', /^data:image\/png/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: DOWNLOAD[lang] }).click()]);
  expect(download.suggestedFilename()).toMatch(/^qr-[A-Za-z0-9_-]{8}\.png$/);
  const bytes = await readFile(await download.path());
  await context.close();
  return bytes;
}

test('MyConnect at 390 px: stats on one line, same bilingual poster from EN and VI', async ({ browser }) => {
  const en = await posterFrom(browser, 'en');
  const vi = await posterFrom(browser, 'vi');
  expect(en.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect([en.readUInt32BE(16), en.readUInt32BE(20)]).toEqual([1080, 1350]);
  expect(vi.equals(en), 'poster bytes identical from EN and VI interfaces').toBe(true);
});
