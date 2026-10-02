import { api } from '../api.js';
import { $, esc } from '../dom.js';
import { errorText, formatVnd, t } from '../i18n.js';
import { icon } from '../nav.js';
import { messageSlot, showMessage } from './common.js';

/**
 * @param {string} label
 * @param {string | number} value
 * @param {string} [sub]
 */
const kpi = (label, value, sub = '') => `
  <div class="kpi">
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value">${esc(String(value))}</span>
    ${sub ? `<span class="dash-sub">${esc(sub)}</span>` : ''}
  </div>`;

/** @param {any} period */
const periodKpis = (period) => `
  <div class="grid-kpi grid-kpi-4">
    ${kpi(t('dashRedemptions'), period.redemptions)}
    ${kpi(t('dashBillTotal'), formatVnd(period.billTotal))}
    ${kpi(t('dashDiscount'), formatVnd(period.discountTotal))}
    ${kpi(t('dashNewVouchers'), period.newVouchers)}
  </div>`;

/** @param {{ partnerId: string, name: string, merchantName?: string | null }} row */
const partnerLink = (row) => `/console/partners?partner=${encodeURIComponent(row.partnerId)}`;

/** @param {{ name: string, merchantName?: string | null }} row */
const partnerName = (row) => (row.merchantName ? `${row.name} · ${row.merchantName}` : row.name);

/** @param {any} data */
function workList(data) {
  if (!data.withCommission) return `<p class="small text-muted mb-0">${esc(t('workManagerHint'))}</p>`;
  const rows = [
    ...data.work.reviews.map(
      (/** @type {any} */ row) =>
        `<li><a href="${partnerLink(row)}" data-nav class="shortcut">${icon('handshake')}<span>${esc(t('workReview', { name: partnerName(row), count: row.count }))}</span></a></li>`,
    ),
    ...data.work.unpaid.map(
      (/** @type {any} */ row) =>
        `<li><a href="${partnerLink(row)}" data-nav class="shortcut">${icon('handshake')}<span>${esc(t('workUnpaid', { name: partnerName(row), amount: formatVnd(row.amount) }))}</span></a></li>`,
    ),
  ];
  return rows.length ? `<ul class="work-list">${rows.join('')}</ul>` : `<p class="small text-muted mb-0">${esc(t('workAllDone'))}</p>`;
}

/** @param {any} data */
function dashboard(data) {
  const commission = data.withCommission
    ? `
      <section class="dash-section">
        <h3 class="card-title">${esc(t('dashCommission'))}</h3>
        <div class="grid-kpi grid-kpi-money3">
          ${kpi(t('dashUnpaid'), formatVnd(data.commission.unpaid), t('dashUnpaidPartners', { count: data.commission.unpaidPartners }))}
          ${kpi(t('dashPaidMonth'), formatVnd(data.commission.paidThisMonth), t('dashPayments', { count: data.commission.paymentsThisMonth }))}
          ${kpi(t('dashWaiting'), formatVnd(data.commission.waitingAmount), t('dashWaitingBills', { count: data.commission.waitingBills }))}
        </div>
      </section>`
    : '';
  return `
    <section class="dash-section">
      <h3 class="card-title">${esc(t('dashToday'))}</h3>
      ${periodKpis(data.today)}
    </section>
    <section class="dash-section">
      <h3 class="card-title">${esc(t('dashMonth'))}</h3>
      ${periodKpis(data.month)}
    </section>
    ${commission}`;
}

/** Placeholder until the numbers arrive. */
export function overviewNumbers() {
  return `<div id="dash-numbers" aria-live="polite"><p class="text-muted small">…</p></div>${messageSlot('dash-message')}`;
}

export function overviewWork() {
  return `<div id="dash-work"><p class="text-muted small mb-0">…</p></div>`;
}

export async function mountOverview() {
  try {
    const data = await api('GET', '/api/v1/dashboard');
    $('#dash-numbers').innerHTML = dashboard(data);
    $('#dash-work').innerHTML = workList(data);
  } catch (error) {
    $('#dash-numbers').innerHTML = '';
    showMessage(errorText(error), 'error', 'dash-message');
  }
}
