import { GUEST_BILL_PHOTOS_MAX, parseVoucherCode } from '#domain';
import { api } from '../api.js';
import { esc } from '../dom.js';
import { errorText, t } from '../i18n.js';
import { langToggle } from './common.js';
import { mountRedeem } from './redeem.js';
import { billPhotoField, bindBillPhoto, bindVoucherActions, fillQr, voucherActions, voucherCard } from './voucher-card.js';

/** @typedef {import('../main.js').App} App */

/** @param {string} body */
export function publicLayout(body) {
  return `
    <main class="auth-shell">
      <section class="auth-card public-card">
        <header class="d-flex justify-content-between align-items-center mb-3">
          <a href="/" data-nav class="brand text-decoration-none">SAPAWOO</a>
          ${langToggle()}
        </header>
        ${body}
      </section>
    </main>`;
}

/**
 * Public voucher page opened from the QR or the shared link. No sign-in needed.
 * @param {App} app
 * @param {string} rawCode
 */
export async function voucherPublicView(app, rawCode) {
  const code = parseVoucherCode(rawCode);
  document.title = `${t('voucherTitle')} · MyConnect`;
  app.root.innerHTML = publicLayout('<div class="py-5 text-center text-muted" id="voucher-page">…</div>');
  const page = /** @type {HTMLElement} */ (document.getElementById('voucher-page'));
  try {
    if (!code) throw { code: 'VOUCHER_NOT_FOUND' };
    const { voucher, canRedeem } = await api('GET', `/api/v1/public/vouchers/${encodeURIComponent(code)}`);
    page.className = '';
    if (canRedeem) {
      const { voucher: full } = await api('GET', `/api/v1/vouchers/${encodeURIComponent(code)}`);
      page.innerHTML = '<div id="public-redeem"></div>';
      mountRedeem(/** @type {HTMLElement} */ (document.getElementById('public-redeem')), full, () => app.navigate('/counter'));
      return;
    }
    const photoOpen = voucher.status !== 'VOID' && voucher.guestBillPhotos < GUEST_BILL_PHOTOS_MAX;
    page.innerHTML = `
      ${voucherCard(voucher)}
      ${voucher.status === 'ACTIVE' ? `<p class="text-center small text-muted mt-3 mb-2">${esc(t('showAtCounter'))}</p>${voucherActions(voucher)}` : ''}
      ${photoOpen ? `<div class="mt-3" id="guest-bill">${billPhotoField('guest-bill-file')}</div>` : ''}`;
    fillQr(page);
    bindVoucherActions(page, voucher);
    if (photoOpen) {
      const box = /** @type {HTMLElement} */ (document.getElementById('guest-bill'));
      bindBillPhoto(box, 'guest-bill-file', `/api/v1/public/vouchers/${encodeURIComponent(code)}/bill-photos`, ({ guestBillPhotos }) => {
        if (guestBillPhotos >= GUEST_BILL_PHOTOS_MAX) /** @type {HTMLElement} */ (box.querySelector('label')).hidden = true;
      });
    }
  } catch (error) {
    page.innerHTML = `<p class="form-message" data-tone="error">${esc(errorText(error))}</p>`;
  }
}
