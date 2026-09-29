import { parseReferralToken, ratePercent } from '#domain';
import { api } from '../api.js';
import { esc } from '../dom.js';
import { errorText, t } from '../i18n.js';
import { publicLayout } from './voucher-public.js';

/** @typedef {import('../main.js').App} App */

/**
 * Page behind a partner QR: the customer taps once to get a voucher. No phone number, no account.
 * A browser that already activated this QR goes straight to its voucher.
 * @param {App} app
 * @param {string} rawToken
 */
export async function referralPublicView(app, rawToken) {
  const token = parseReferralToken(rawToken);
  document.title = `${t('referralOffer')} · MyConnect`;
  app.root.innerHTML = publicLayout('<div class="py-5 text-center text-muted" id="referral-page">…</div>');
  const page = /** @type {HTMLElement} */ (document.getElementById('referral-page'));
  const failed = (/** @type {unknown} */ error) => {
    page.className = '';
    page.innerHTML = `
      <p class="form-message" data-tone="error">${esc(errorText(error))}</p>
      <a href="/" data-nav class="btn btn-outline-secondary w-100">${esc(t('backHome'))}</a>`;
  };
  try {
    if (!token) throw { code: 'REFERRAL_NOT_FOUND' };
    const path = `/api/v1/public/referrals/${encodeURIComponent(token)}`;
    const { referral, voucher } = await api('GET', path);
    if (voucher) return app.navigate(`/v/${voucher.code}`, { replace: true });
    page.className = '';
    page.innerHTML = `
      <article class="vcard">
        <header class="vcard-head">
          <span class="vcard-eyebrow">${esc(t('referralOffer'))}</span>
          <span class="vcard-merchant" translate="no">${esc(referral.merchantName)}</span>
          <span class="vcard-customer">${esc(t('introducedBy', { name: referral.partnerName }))}</span>
        </header>
        <div class="vcard-body">
          <p class="vcard-discount">${esc(t('percentOff', { value: ratePercent(referral.discountRate) }))}</p>
          <p class="vcard-terms">${esc(t('referralTerms', { days: referral.validityDays }))}</p>
          <p class="vcard-note mb-0">${esc(t('referralNoSignup'))}</p>
        </div>
      </article>
      <button type="button" class="btn btn-primary btn-lg w-100 mt-3" id="referral-activate">${esc(t('getVoucher'))}</button>
      <p class="form-message mt-2" id="referral-message" role="status" aria-live="polite" hidden></p>`;
    const button = /** @type {HTMLButtonElement} */ (document.getElementById('referral-activate'));
    const message = /** @type {HTMLElement} */ (document.getElementById('referral-message'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      message.hidden = true;
      try {
        const { voucher: created } = await api('POST', `${path}/activate`, {});
        app.navigate(`/v/${created.code}`, { replace: true });
      } catch (error) {
        button.disabled = false;
        message.hidden = false;
        message.dataset.tone = 'error';
        message.textContent = errorText(error);
      }
    });
  } catch (error) {
    failed(error);
  }
}
