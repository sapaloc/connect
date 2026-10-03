import { api, fetchProfile } from '../api.js';
import { $, esc, formValues } from '../dom.js';
import { errorText, formatDate, t } from '../i18n.js';
import { messageSlot, showMessage } from './common.js';
import { formDialog } from './partners.js';

/** @typedef {import('../main.js').App} App */
/**
 * @typedef {{
 *   id: string, name: string, address: string | null, brand: import('../voucher-ui.js').Brand | null,
 *   acceptsNewPartners: boolean, partner: boolean,
 *   request: null | { id: string, status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED', createdAt: string,
 *     reviewedAt: string | null, rejectReason: string | null },
 * }} Merchant
 */

const SEARCH_DELAY_MS = 250;

/** @param {string} name */
const initial = (name) => (name.trim()[0] ?? '?').toUpperCase();

/**
 * Merchants accepting new partners, a search box, and per merchant: ask to join, requested, or already a partner.
 * @param {{ framed: boolean }} options `framed`: a card inside MyConnect, bare on the plain page
 */
export function findMerchantsPanel({ framed }) {
  return `
    <section class="fm${framed ? ' card-sw' : ''}" aria-labelledby="fm-title">
      <h2 class="visually-hidden" id="fm-title">${esc(t('findMerchantsTitle'))}</h2>
      <p class="small text-muted mb-3">${esc(t('fmIntro'))}</p>
      <label for="fm-q" class="visually-hidden">${esc(t('fmSearch'))}</label>
      <input id="fm-q" type="search" class="form-control mb-2" placeholder="${esc(t('fmSearch'))}" maxlength="80" autocomplete="off" />
      <p class="small text-muted mb-3" id="fm-count" aria-live="polite"></p>
      <div id="fm-joined" class="fm-joined" hidden></div>
      ${messageSlot('fm-message')}
      <div id="fm-list" class="application-list mt-3"></div>
    </section>`;
}

/** @param {Merchant} m */
function statusBlock(m) {
  if (m.partner) return `<span class="pill pill-active">${esc(t('fmAlreadyPartner'))}</span>`;
  const request = m.request;
  if (request?.status === 'PENDING') {
    return `
      <p class="small mb-1"><span class="pill pill-paused">${esc(t('fmRequested'))}</span></p>
      <p class="small text-muted mb-1">${esc(t('fmRequestedOn', { date: formatDate(request.createdAt) }))}</p>
      ${m.acceptsNewPartners ? '' : `<p class="small text-muted mb-1">${esc(t('fmNotAccepting'))}</p>`}`;
  }
  if (request?.status === 'REJECTED') {
    return `
      <p class="small mb-1">${esc(t('fmRejected', { date: formatDate(request.reviewedAt ?? request.createdAt) }))}</p>
      ${request.rejectReason ? `<p class="small text-muted mb-1 text-break">${esc(t('fmRejectedReason', { reason: request.rejectReason }))}</p>` : ''}`;
  }
  return '';
}

/** @param {Merchant} m */
function actionButton(m) {
  if (m.partner) return '';
  if (m.request?.status === 'PENDING') {
    return `<button type="button" class="btn btn-outline-secondary" data-cancel="${esc(m.id)}">${esc(t('fmCancel'))}</button>`;
  }
  const label = m.request?.status === 'REJECTED' ? t('fmAskAgain') : t('fmRequest');
  return `<button type="button" class="btn btn-primary" data-request="${esc(m.id)}">${esc(label)}</button>`;
}

/** @param {Merchant} m */
function merchantCard(m) {
  const logo = m.brand?.logoUrl
    ? `<img src="${esc(m.brand.logoUrl)}" alt="" width="48" height="48" loading="lazy" />`
    : `<span aria-hidden="true">${esc(initial(m.name))}</span>`;
  const action = actionButton(m);
  return `
    <article class="application fm-merchant" data-merchant="${esc(m.id)}">
      <div class="fm-main">
        <span class="fm-logo"${m.brand?.color ? ` style="background:${esc(m.brand.color)};color:${esc(m.brand.textColor ?? '#fff')}"` : ''}>${logo}</span>
        <div class="fm-text">
          <h3 class="h6 mb-1">${esc(m.name)}</h3>
          ${m.address ? `<p class="small text-muted mb-1 text-break">${esc(m.address)}</p>` : ''}
          ${statusBlock(m)}
        </div>
      </div>
      ${action ? `<div class="fm-actions">${action}</div>` : ''}
    </article>`;
}

/** @param {App} app */
export function mountFindMerchants(app) {
  const noMerchantYet = !app.state.profile?.activeRole;
  const input = /** @type {HTMLInputElement} */ ($('#fm-q'));
  /** @type {Merchant[]} */
  let merchants = [];
  let query = '';
  let loadId = 0;

  const load = async () => {
    const id = ++loadId;
    try {
      const data = await api('GET', `/api/v1/partner-merchants${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      if (id !== loadId) return;
      merchants = data.merchants;
      $('#fm-count').textContent = data.pendingCount ? t('fmPendingCount', { count: data.pendingCount, max: data.maxPending }) : '';
      $('#fm-list').innerHTML = merchants.length
        ? merchants.map(merchantCard).join('')
        : `<p class="text-muted small mb-0">${esc(query ? t('fmNoMatch', { q: query }) : t('fmNone'))}</p>`;
      const joined = noMerchantYet ? merchants.find((m) => m.partner) : null;
      const box = $('#fm-joined');
      box.hidden = !joined;
      if (joined) {
        box.innerHTML = `
          <p class="small mb-2">${esc(t('fmJoinedNote', { name: joined.name }))}</p>
          <button type="button" class="btn btn-primary w-100" data-open-my>${esc(t('fmOpenMy'))}</button>`;
      }
    } catch (error) {
      showMessage(errorText(error), 'error', 'fm-message');
    }
  };

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query = input.value.trim();
      load();
    }, SEARCH_DELAY_MS);
  });

  $('.fm').addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);

    if (target.closest('[data-open-my]')) {
      try {
        const profile = await fetchProfile();
        app.setProfile(profile);
        app.navigate(profile?.activeRole ? /** @type {string} */ (profile.landing) : '/select-role', { replace: true });
      } catch (error) {
        showMessage(errorText(error), 'error', 'fm-message');
      }
      return;
    }

    const requestButton = /** @type {HTMLButtonElement | null} */ (target.closest('button[data-request]'));
    if (requestButton) {
      const merchant = merchants.find((m) => m.id === requestButton.dataset.request);
      if (!merchant) return;
      formDialog({
        title: t('fmDialogTitle', { name: merchant.name }),
        body: `
          <p class="small text-muted">${esc(t('fmDialogHint'))}</p>
          <label for="fm-message-input" class="form-label small">${esc(t('fmMessage'))} <span class="text-muted">(${esc(t('optional'))})</span></label>
          <textarea id="fm-message-input" name="message" class="form-control" rows="3" maxlength="500" placeholder="${esc(t('fmMessagePlaceholder'))}"></textarea>`,
        submit: t('fmSend'),
        onSubmit: async (form) => {
          await api('POST', '/api/v1/partner-join-requests', { merchantId: merchant.id, message: formValues(form).message });
          showMessage(t('fmSent', { name: merchant.name }), 'success', 'fm-message');
          await load();
        },
      });
      return;
    }

    const cancelButton = /** @type {HTMLButtonElement | null} */ (target.closest('button[data-cancel]'));
    if (cancelButton) {
      const merchant = merchants.find((m) => m.id === cancelButton.dataset.cancel);
      if (!merchant?.request || !confirm(t('fmCancelConfirm', { name: merchant.name }))) return;
      cancelButton.disabled = true;
      try {
        await api('POST', `/api/v1/partner-join-requests/${encodeURIComponent(merchant.request.id)}/cancel`, {});
        showMessage(t('fmCancelled', { name: merchant.name }), 'success', 'fm-message');
        await load();
      } catch (error) {
        cancelButton.disabled = false;
        showMessage(errorText(error), 'error', 'fm-message');
      }
    }
  });

  load();
}
