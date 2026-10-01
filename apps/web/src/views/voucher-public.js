import { GUEST_BILL_PHOTOS_MAX, parseVoucherCode } from '#domain';
import { api } from '../api.js';
import { esc } from '../dom.js';
import { errorText, t } from '../i18n.js';
import { startPolling } from '../poll.js';
import { langToggle } from './common.js';
import { amountRows, mountRedeem } from './redeem.js';
import { billPhotoField, bindBillPhoto, bindVoucherActions, fillQr, voucherActions, voucherCard } from './voucher-card.js';

/** @typedef {import('../main.js').App} App */
/** @typedef {import('../voucher-ui.js').Voucher} Voucher */

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
    renderGuestVoucher(page, voucher, code);
    if (voucher.source === 'REFERRAL' && voucher.status === 'ACTIVE') watchConfirmation(page, voucher, code);
  } catch (error) {
    page.innerHTML = `<p class="form-message" data-tone="error">${esc(errorText(error))}</p>`;
  }
}

/**
 * @param {HTMLElement} page
 * @param {Voucher} voucher
 * @param {string} code
 * @param {string} [notice] success line above the card
 */
function renderGuestVoucher(page, voucher, code, notice = '') {
  const photoOpen = voucher.status !== 'VOID' && (voucher.guestBillPhotos ?? 0) < GUEST_BILL_PHOTOS_MAX;
  page.innerHTML = `
    ${notice ? `<p class="form-message mb-3" data-tone="success">${esc(notice)}</p>` : ''}
    <div id="guest-confirm"></div>
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
}

/**
 * Partner voucher on the phone that took it: poll every 2 s for a bill the counter sent and let the
 * guest confirm or decline. Any other browser stops after the first answer.
 * @param {HTMLElement} page
 * @param {Voucher} voucher
 * @param {string} code
 */
function watchConfirmation(page, voucher, code) {
  const fromConfirmQr = new URLSearchParams(location.search).has('confirm');
  const path = `/api/v1/public/vouchers/${encodeURIComponent(code)}/confirmation`;
  /** @type {string | null} */
  let shownId = null;
  let declinedId = '';

  const box = () => /** @type {HTMLElement | null} */ (page.querySelector('#guest-confirm'));

  const stop = startPolling(async () => {
    if (!page.isConnected) return false;
    const state = await api('GET', path);
    const slot = box();
    if (!slot) return false;
    if (!state.owner) {
      if (fromConfirmQr) slot.innerHTML = `<p class="form-message mb-3" data-tone="error">${esc(t('confirmWrongPhone'))}</p>`;
      return false;
    }
    if (state.voucherStatus !== 'ACTIVE') {
      const { voucher: latest } = await api('GET', `/api/v1/public/vouchers/${encodeURIComponent(code)}`);
      renderGuestVoucher(page, latest, code);
      return false;
    }
    const pending = state.confirmation;
    if (!pending || pending.id === declinedId) {
      if (shownId) slot.innerHTML = '';
      shownId = null;
      return true;
    }
    if (pending.id !== shownId) {
      shownId = pending.id;
      slot.innerHTML = confirmBox(voucher, pending);
    }
    return true;
  });

  page.addEventListener('click', async (event) => {
    const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('button[data-answer]'));
    if (!button || !shownId) return;
    const id = shownId;
    const slot = /** @type {HTMLElement} */ (box());
    slot.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      if (button.dataset.answer === 'yes') {
        const { voucher: redeemed } = await api('POST', `/api/v1/public/confirmations/${id}/confirm`, {});
        stop();
        renderGuestVoucher(page, redeemed, code, t('guestConfirmed'));
      } else {
        await api('POST', `/api/v1/public/confirmations/${id}/decline`, {});
        declinedId = id;
        shownId = null;
        slot.innerHTML = `<p class="form-message mb-3" data-tone="info">${esc(t('guestDeclined'))}</p>`;
      }
    } catch (error) {
      slot.innerHTML = `<p class="form-message mb-3" data-tone="error">${esc(errorText(error))}</p>`;
      shownId = null;
    }
  });
}

/**
 * @param {Voucher} voucher
 * @param {{ grossAmount: string, discountAmount: string, payableAmount: string }} pending
 */
function confirmBox(voucher, pending) {
  return `
    <section class="guest-confirm mb-3" role="alertdialog" aria-labelledby="guest-confirm-title">
      <p class="redeem-step mb-1" id="guest-confirm-title">${esc(t('guestConfirmTitle', { merchant: voucher.merchantName ?? 'MyConnect' }))}</p>
      <p class="small text-muted mb-2">${esc(t('guestConfirmHint'))}</p>
      ${amountRows(pending)}
      <div class="d-grid gap-2">
        <button type="button" class="btn btn-primary btn-lg" data-answer="yes">${esc(t('guestConfirmYes'))}</button>
        <button type="button" class="btn btn-outline-secondary" data-answer="no">${esc(t('guestConfirmNo'))}</button>
      </div>
    </section>`;
}
