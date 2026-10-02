import { formatVoucherCode } from '#domain';
import { api } from '../api.js';
import { esc } from '../dom.js';
import { errorText, formatDate, formatDateTime, formatVnd, t } from '../i18n.js';
import { messageSlot, showMessage } from './common.js';

const STATUSES = ['OPEN', 'PENDING', 'PAID', 'VOID'];
/** @type {Record<string, string>} */
const PILL = { OPEN: 'pill-unpaid', PAID: 'pill-redeemed', VOID: 'pill-void', PENDING: '' };

/**
 * A modal with a close button; removed from the page when closed.
 * @param {string} body
 * @param {{ wide?: boolean }} [options]
 */
export function openDialog(body, { wide = false } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = `vdialog${wide ? ' vdialog-wide' : ''}`;
  dialog.innerHTML = `
    <div class="vdialog-inner">
      <button type="button" class="btn-close vdialog-close" data-close aria-label="${esc(t('close'))}"></button>
      ${body}
    </div>`;
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || /** @type {HTMLElement} */ (event.target).closest('[data-close]')) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/**
 * One bill: when, what the guest paid, the commission and its status. The voucher code only for the merchant.
 * @param {any} item
 * @param {boolean} withCode
 */
export function historyItem(item, withCode) {
  const code = withCode && item.code ? ` · <span class="font-monospace" translate="no">${esc(formatVoucherCode(item.code))}</span>` : '';
  return `
    <li class="history-item">
      <div class="history-main">
        <span class="small text-muted">${esc(formatDateTime(item.redeemedAt))}${code}</span>
        <span class="small">${esc(t('historyGuestPaid', { amount: formatVnd(item.baseAmount) }))}</span>
      </div>
      <div class="history-side">
        <span class="fw-semibold${item.status === 'VOID' ? ' text-decoration-line-through text-muted' : ''}">${esc(formatVnd(item.amount))}</span>
        <span class="pill pill-sm ${PILL[item.status] ?? ''}">${esc(t(`cstatus_${item.status}`))}</span>
        ${item.paidAt ? `<span class="small text-muted">${esc(t('historyPaidOn', { date: formatDate(item.paidAt) }))}</span>` : ''}
      </div>
    </li>`;
}

/**
 * A payment as a button that opens its bills.
 * @param {any} payout
 */
export function payoutItem(payout) {
  const by = payout.paidByName ? ` · ${esc(payout.paidByName)}` : '';
  return `
    <li>
      <button type="button" class="history-payout" data-payout="${esc(payout.id)}" aria-label="${esc(t('payoutOpen'))}">
        <span class="history-main">
          <span class="small text-muted">${esc(formatDateTime(payout.paidAt))}${by}</span>
          <span class="small">${esc(t('payoutBills', { count: payout.itemCount }))}${payout.note ? ` · ${esc(payout.note)}` : ''}</span>
        </span>
        <span class="history-side">
          <span class="fw-semibold">${esc(formatVnd(payout.amount))}</span>
          <span class="pill pill-sm pill-redeemed">${esc(t('cstatus_PAID'))}</span>
        </span>
      </button>
    </li>`;
}

/**
 * @param {string} url payout detail endpoint
 * @param {boolean} withCode
 */
export async function openPayout(url, withCode) {
  const { payout, items } = await api('GET', url);
  openDialog(`
    <h2 class="h5 mb-1 pe-4">${esc(t('payoutTitle', { date: formatDate(payout.paidAt) }))}</h2>
    <p class="mb-1"><strong>${esc(formatVnd(payout.amount))}</strong> <span class="small text-muted">· ${esc(t('payoutBills', { count: payout.itemCount }))}</span></p>
    ${payout.paidByName ? `<p class="small text-muted mb-1">${esc(t('payoutBy', { name: payout.paidByName }))}</p>` : ''}
    ${payout.note ? `<p class="small mb-0">${esc(t('payoutNote', { note: payout.note }))}</p>` : ''}
    <ul class="history-list mt-3">${items.map((/** @type {any} */ item) => historyItem(item, withCode)).join('')}</ul>`);
}

/**
 * Filters, period totals, the bills and "Load more".
 * @param {string} prefix element id prefix
 */
export function historyBlock(prefix) {
  return `
    <div class="history-filters">
      <select id="${prefix}-status" class="form-select form-select-sm" aria-label="${esc(t('status'))}">
        <option value="">${esc(t('historyAllStatuses'))}</option>
        ${STATUSES.map((status) => `<option value="${status}">${esc(t(`cstatus_${status}`))}</option>`).join('')}
      </select>
      <select id="${prefix}-period" class="form-select form-select-sm" aria-label="${esc(t('historyAllTime'))}">
        <option value="">${esc(t('historyAllTime'))}</option>
        <option value="this_month">${esc(t('period_this_month'))}</option>
        <option value="last_month">${esc(t('period_last_month'))}</option>
      </select>
    </div>
    <dl class="partner-stats history-totals" id="${prefix}-totals"></dl>
    <ul class="history-list" id="${prefix}-list"></ul>
    <button type="button" class="btn btn-sm btn-outline-secondary w-100 mt-2" id="${prefix}-more" hidden>${esc(t('loadMore'))}</button>
    ${messageSlot(`${prefix}-message`)}`;
}

/**
 * @param {ParentNode} root
 * @param {string} prefix
 * @param {{ url: string, withCode: boolean, onFirstPage?: (data: any) => void }} options
 */
export function mountHistory(root, prefix, { url, withCode, onFirstPage }) {
  const pick = (/** @type {string} */ id) => /** @type {HTMLElement} */ (root.querySelector(`#${prefix}-${id}`));
  const status = /** @type {HTMLSelectElement} */ (pick('status'));
  const period = /** @type {HTMLSelectElement} */ (pick('period'));
  const list = pick('list');
  const more = /** @type {HTMLButtonElement} */ (pick('more'));
  /** @type {string | null} */
  let next = null;

  /** @param {boolean} [append] */
  const load = async (append = false) => {
    const params = new URLSearchParams();
    if (status.value) params.set('status', status.value);
    if (period.value) params.set('period', period.value);
    if (append && next) params.set('before', next);
    more.disabled = true;
    try {
      const data = await api('GET', `${url}?${params}`);
      if (!append) {
        const stat = (/** @type {string} */ label, /** @type {any} */ total) =>
          `<div class="partner-stat"><dt>${esc(label)}</dt><dd>${esc(formatVnd(total.amount))}</dd></div>`;
        pick('totals').innerHTML = [
          stat(t('historyTotalOpen'), data.totals.OPEN),
          stat(t('historyTotalPaid'), data.totals.PAID),
          stat(t('historyTotalPending'), data.totals.PENDING),
        ].join('');
        list.innerHTML = data.items.length ? '' : `<li class="small text-muted">${esc(t('historyEmpty'))}</li>`;
        onFirstPage?.(data);
      }
      list.insertAdjacentHTML('beforeend', data.items.map((/** @type {any} */ item) => historyItem(item, withCode)).join(''));
      next = data.next;
      more.hidden = !next;
      showMessage('', 'info', `${prefix}-message`);
    } catch (error) {
      showMessage(errorText(error), 'error', `${prefix}-message`);
    } finally {
      more.disabled = false;
    }
  };
  status.addEventListener('change', () => load());
  period.addEventListener('change', () => load());
  more.addEventListener('click', () => load(true));
  return load();
}
