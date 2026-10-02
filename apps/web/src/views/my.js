import { api } from '../api.js';
import { $, esc, formValues } from '../dom.js';
import { errorText, formatVnd, t } from '../i18n.js';
import { downloadBlob, partnerQrImage, referralLink, referralQrDataUrl, ruleDiscount, ruleTerms, sharePartnerQr, shortLink } from '../voucher-ui.js';
import { messageSlot, showMessage } from './common.js';
import { historyBlock, mountHistory, openPayout, payoutItem } from './history.js';

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

const PARTNER_ROLES = ['PARTNER_ADMIN', 'REFERRER'];

/**
 * One chip per merchant the partner works with; hidden when there is only one.
 * @param {import('../api.js').Profile} profile
 */
function merchantSwitch(profile) {
  const options = profile.roles.filter((option) => PARTNER_ROLES.includes(option.role));
  if (options.length < 2) return '';
  return `
    <nav class="merchant-switch" aria-label="${esc(t('myMerchants'))}">
      ${options
        .map((option) => {
          const current = option.roleAssignmentId === profile.activeRole?.roleAssignmentId;
          return `<button type="button" class="btn btn-sm ${current ? 'btn-primary' : 'btn-outline-secondary'}" data-switch="${esc(option.roleAssignmentId)}" aria-pressed="${current}">${esc(option.tenantName ?? '')}</button>`;
        })
        .join('')}
    </nav>`;
}

/** @param {any} partner */
function contactCard(partner) {
  return `
    <section class="card-sw">
      <h3 class="card-title">${esc(t('myContact'))}</h3>
      <p class="small text-muted">${esc(t('myContactHint'))}</p>
      <form id="my-contact" class="row g-3" novalidate>
        <div class="col-12">
          <label for="my-contact-name" class="form-label small">${esc(t('contactName'))}</label>
          <input id="my-contact-name" name="contactName" class="form-control" maxlength="120" autocomplete="name" value="${esc(partner.contactName ?? '')}" />
        </div>
        <div class="col-12 col-sm-6">
          <label for="my-contact-phone" class="form-label small">${esc(t('contactPhone'))}</label>
          <input id="my-contact-phone" name="contactPhone" type="tel" class="form-control" maxlength="32" autocomplete="tel" value="${esc(partner.contactPhone ?? '')}" />
        </div>
        <div class="col-12 col-sm-6">
          <label for="my-contact-email" class="form-label small">${esc(t('email'))}</label>
          <input id="my-contact-email" name="contactEmail" type="email" class="form-control" maxlength="254" autocomplete="email" value="${esc(partner.contactEmail ?? '')}" />
        </div>
        <div class="col-12">
          <button type="submit" class="btn btn-primary">${esc(t('saveBtn'))}</button>
        </div>
      </form>
      ${messageSlot('my-contact-message')}
    </section>`;
}

/** @param {App} app */
export async function mountMy(app) {
  const page = $('#my-page');
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  try {
    const data = await api('GET', '/api/v1/my/partner');
    const { partner, rule, qr, stats, recent, payouts } = data;
    const hasActivity = recent.length > 0 || stats.pendingReviews > 0;
    const share = qr
      ? { token: qr.token, merchantName: partner.merchantName ?? 'MyConnect', partnerName: partner.name, discount: ruleDiscount(rule), brand: partner.brand }
      : null;

    page.innerHTML = `
      ${merchantSwitch(profile)}
      <section class="card-sw">
        <p class="eyebrow mb-1">${esc(partner.merchantName ?? '')}</p>
        <h2 class="h5 mb-2">${esc(partner.name)}</h2>
        ${
          rule
            ? `<p class="small mb-3 text-balance">${esc(t(rule.customerDiscountAmount ? 'myRuleLine' : 'myRuleLinePercent', ruleTerms(rule)))}</p>`
            : ''
        }
        ${partner.status === 'PAUSED' ? `<p class="form-message" data-tone="error">${esc(t('myPaused'))}</p>` : ''}
        ${
          share
            ? `<div class="partner-qr"><img id="my-qr" alt="QR ${esc(partner.name)}" width="240" height="240" /></div>
               <p class="partner-qr-link small font-monospace text-center" translate="no" title="${esc(referralLink(share.token))}">${esc(shortLink(referralLink(share.token)))}</p>
               <div class="vcard-actions">
                 <button type="button" class="btn btn-primary" data-my-share>${esc(t('share'))}</button>
                 <button type="button" class="btn btn-outline-secondary" data-my-download>${esc(t('downloadImage'))}</button>
                 <button type="button" class="btn btn-outline-secondary" data-my-copy>${esc(t('copyLink'))}</button>
               </div>
               ${messageSlot('my-qr-message')}`
            : `<p class="text-muted mb-0">${esc(t('myNoQr'))}</p>`
        }
      </section>

      <section class="grid-kpi grid-kpi-3">
        ${kpi(t('kpiOpens'), stats.opens)}
        ${kpi(t('kpiActivations'), stats.activations)}
        ${kpi(t('kpiRedemptions'), stats.redemptions)}
      </section>
      <section class="grid-kpi">
        ${kpi(t('commissionOwed'), formatVnd(stats.commissionOpen))}
        ${kpi(t('commissionPaid'), formatVnd(stats.commissionPaid))}
      </section>
      ${
        stats.pendingReviews
          ? `<p class="partner-pending small mb-0">${esc(t('commissionPendingLine', { amount: formatVnd(stats.commissionPending), count: stats.pendingReviews }))}</p>`
          : ''
      }

      <section class="card-sw" id="my-history">
        <h3 class="card-title">${esc(t('historyTitle'))}</h3>
        ${hasActivity ? historyBlock('my-h') : `<p class="text-muted small mb-0">${esc(t('myNoRecent'))}</p>`}
      </section>

      <section class="card-sw">
        <h3 class="card-title">${esc(t('myPayouts'))}</h3>
        ${
          payouts.length
            ? `<ul class="payout-list" id="my-payouts">${payouts.map(payoutItem).join('')}</ul>`
            : `<p class="text-muted small mb-0">${esc(t('myNoPayouts'))}</p>`
        }
        <p class="small text-muted mt-3 mb-0">${esc(t('myPayNote'))}</p>
      </section>
      ${partner.status === 'ENDED' ? '' : contactCard(partner)}`;

    if (hasActivity) mountHistory(page, 'my-h', { url: '/api/v1/my/partner/history', withCode: false });
    page.querySelector('#my-payouts')?.addEventListener('click', (event) => {
      const id = /** @type {HTMLElement} */ (event.target).closest('[data-payout]')?.getAttribute('data-payout');
      if (id) openPayout(`/api/v1/my/partner/payouts/${encodeURIComponent(id)}`, false).catch((error) => showMessage(errorText(error), 'error', 'my-message'));
    });

    const contactForm = /** @type {HTMLFormElement | null} */ (page.querySelector('#my-contact'));
    contactForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = /** @type {HTMLButtonElement} */ (contactForm.querySelector('button[type=submit]'));
      submit.disabled = true;
      try {
        await api('POST', '/api/v1/my/partner/contact', formValues(contactForm));
        showMessage(t('myContactSaved'), 'success', 'my-contact-message');
      } catch (error) {
        showMessage(errorText(error), 'error', 'my-contact-message');
      } finally {
        submit.disabled = false;
      }
    });

    page.addEventListener('click', async (event) => {
      const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('button[data-switch]'));
      if (!button || button.getAttribute('aria-pressed') === 'true') return;
      button.disabled = true;
      try {
        const next = await api('POST', '/api/v1/auth/select-role', { roleAssignmentId: button.getAttribute('data-switch') });
        app.setProfile(next);
        app.navigate(/** @type {string} */ (next.landing), { replace: true });
      } catch (error) {
        showMessage(errorText(error), 'error', 'my-message');
        button.disabled = false;
      }
    });

    if (!share) return;
    /** @type {HTMLImageElement} */ ($('#my-qr')).src = await referralQrDataUrl(share.token, 480);
    page.addEventListener('click', async (event) => {
      const button = /** @type {HTMLButtonElement | null} */ (
        /** @type {HTMLElement} */ (event.target).closest('button[data-my-share], button[data-my-download], button[data-my-copy]')
      );
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
