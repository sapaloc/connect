import { ratePercent } from '#domain';
import { api } from '../api.js';
import { $, esc } from '../dom.js';
import { errorText, formatDateTime, formatVnd, t } from '../i18n.js';
import { downloadBlob, partnerQrImage, referralLink, referralQrDataUrl, sharePartnerQr } from '../voucher-ui.js';
import { messageSlot, showMessage } from './common.js';

/** @typedef {import('../main.js').App} App */

/** MyConnect home of a partner: QR first (what they use every day), then results and commission. */
export function myPanel() {
  return `
    <div id="my-page" class="my-page">
      <p class="text-muted">…</p>
    </div>
    ${messageSlot('my-message')}`;
}

/**
 * @param {string} label
 * @param {string | number} value
 */
const kpi = (label, value) => `
  <div class="kpi">
    <span class="kpi-label d-block">${esc(label)}</span>
    <span class="kpi-value">${esc(String(value))}</span>
  </div>`;

/** @param {App} _app */
export async function mountMy(_app) {
  const page = $('#my-page');
  try {
    const data = await api('GET', '/api/v1/my/partner');
    const { partner, rule, qr, stats, recent } = data;
    const share = qr
      ? { token: qr.token, merchantName: partner.merchantName ?? 'MyConnect', partnerName: partner.name, discountRate: rule?.customerDiscountRate ?? null }
      : null;

    page.innerHTML = `
      <section class="card-sw">
        <p class="eyebrow mb-1">${esc(partner.merchantName ?? '')}</p>
        <h2 class="h5 mb-2">${esc(partner.name)}</h2>
        ${
          rule
            ? `<p class="small mb-3">${esc(t('myRuleLine', { discount: ratePercent(rule.customerDiscountRate), commission: ratePercent(rule.commissionRate ?? '0') }))}</p>`
            : ''
        }
        ${partner.status === 'PAUSED' ? `<p class="form-message" data-tone="error">${esc(t('myPaused'))}</p>` : ''}
        ${
          share
            ? `<div class="partner-qr"><img id="my-qr" alt="QR ${esc(partner.name)}" width="240" height="240" /></div>
               <p class="partner-qr-link small font-monospace text-center" translate="no">${esc(referralLink(share.token))}</p>
               <div class="vcard-actions">
                 <button type="button" class="btn btn-primary" data-my-share>${esc(t('share'))}</button>
                 <button type="button" class="btn btn-outline-secondary" data-my-download>${esc(t('downloadImage'))}</button>
                 <button type="button" class="btn btn-outline-secondary" data-my-copy>${esc(t('copyLink'))}</button>
               </div>
               ${messageSlot('my-qr-message')}`
            : `<p class="text-muted mb-0">${esc(t('myNoQr'))}</p>`
        }
      </section>

      <section class="grid-kpi">
        ${kpi(t('kpiOpens'), stats.opens)}
        ${kpi(t('kpiActivations'), stats.activations)}
        ${kpi(t('kpiRedemptions'), stats.redemptions)}
        ${kpi(t('commissionOwed'), formatVnd(stats.commissionOpen))}
      </section>

      <section class="card-sw">
        <h3 class="card-title">${esc(t('myRecent'))}</h3>
        ${
          recent.length
            ? `<ul class="my-recent">${recent
                .map(
                  (/** @type {any} */ item) => `
                <li>
                  <span class="text-muted small">${esc(formatDateTime(item.redeemedAt))}</span>
                  <span class="fw-semibold${item.status === 'VOID' ? ' text-decoration-line-through text-muted' : ''}">${esc(formatVnd(item.amount))}</span>
                  <span class="pill pill-${item.status === 'VOID' ? 'void' : item.status === 'PAID' ? 'redeemed' : 'active'}">${esc(t(`cstatus_${item.status}`))}</span>
                </li>`,
                )
                .join('')}</ul>`
            : `<p class="text-muted small mb-0">${esc(t('myNoRecent'))}</p>`
        }
        <p class="small text-muted mt-3 mb-0">${esc(t('myPayNote'))}</p>
      </section>`;

    if (!share) return;
    /** @type {HTMLImageElement} */ ($('#my-qr')).src = await referralQrDataUrl(share.token, 480);
    page.addEventListener('click', async (event) => {
      const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('button'));
      if (!button) return;
      button.disabled = true;
      try {
        if (button.hasAttribute('data-my-share')) {
          if ((await sharePartnerQr(share)) === 'downloaded') showMessage(t('imageDownloaded'), 'success', 'my-qr-message');
        } else if (button.hasAttribute('data-my-download')) {
          downloadBlob(await partnerQrImage(share), `qr-${share.token.slice(0, 8)}.png`);
        } else if (button.hasAttribute('data-my-copy')) {
          await navigator.clipboard.writeText(referralLink(share.token));
          showMessage(t('copied'), 'success', 'my-qr-message');
        }
      } catch (error) {
        showMessage(errorText(error), 'error', 'my-qr-message');
      } finally {
        button.disabled = false;
      }
    });
  } catch (error) {
    page.innerHTML = '';
    showMessage(errorText(error), 'error', 'my-message');
  }
}
