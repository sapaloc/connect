import { api, apiFile } from '../api.js';
import { esc } from '../dom.js';
import { errorText, formatDate, formatVnd, t } from '../i18n.js';
import { downloadBlob } from '../voucher-ui.js';
import { messageSlot, showMessage } from './common.js';

const PERIODS = ['this_month', 'last_month', 'custom'];
const COMMISSION = ['OPEN', 'PAID', 'PENDING', 'VOID'];

/** Today in Vietnam, YYYY-MM-DD: periods are whole Vietnam days whatever the device clock zone. */
const vnToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

/** @param {string} day YYYY-MM-DD */
const formatDay = (day) => formatDate(`${day}T00:00:00+07:00`);

/** @param {unknown} error */
const reportError = (error) => (/** @type {{ code?: string }} */ (error)?.code === 'VALIDATION' ? t('reportDatesInvalid') : errorText(error));

/**
 * This month / last month / custom dates (Vietnam time, both days included).
 * @param {string} prefix
 */
function periodPicker(prefix) {
  const today = vnToday();
  return `
    <div class="report-period">
      <div class="btn-group w-100" role="group" aria-label="${esc(t('reportPeriod'))}">
        ${PERIODS.map(
          (value, index) => `
          <input type="radio" class="btn-check" name="${prefix}-period" id="${prefix}-period-${value}" value="${value}"${index === 0 ? ' checked' : ''} />
          <label class="btn btn-sm btn-outline-secondary" for="${prefix}-period-${value}">${esc(t(`period_${value}`))}</label>`,
        ).join('')}
      </div>
      <div class="report-dates" id="${prefix}-dates" hidden>
        <div>
          <label for="${prefix}-from" class="form-label small">${esc(t('periodFrom'))}</label>
          <input type="date" id="${prefix}-from" class="form-control form-control-sm" value="${today.slice(0, 8)}01" max="${today}" />
        </div>
        <div>
          <label for="${prefix}-to" class="form-label small">${esc(t('periodTo'))}</label>
          <input type="date" id="${prefix}-to" class="form-control form-control-sm" value="${today}" max="${today}" />
        </div>
      </div>
    </div>`;
}

/**
 * Query string of the chosen period; null while the custom dates are incomplete or reversed.
 * @param {ParentNode} root
 * @param {string} prefix
 */
function periodQuery(root, prefix) {
  const chosen = /** @type {HTMLInputElement | null} */ (root.querySelector(`input[name="${prefix}-period"]:checked`))?.value ?? PERIODS[0];
  if (chosen !== 'custom') return new URLSearchParams({ period: chosen });
  const from = /** @type {HTMLInputElement} */ (root.querySelector(`#${prefix}-from`)).value;
  const to = /** @type {HTMLInputElement} */ (root.querySelector(`#${prefix}-to`)).value;
  return from && to && from <= to ? new URLSearchParams({ from, to }) : null;
}

/**
 * @param {ParentNode} root
 * @param {string} prefix
 * @param {() => void} onChange
 */
function bindPeriod(root, prefix, onChange) {
  const dates = /** @type {HTMLElement} */ (root.querySelector(`#${prefix}-dates`));
  root.querySelector('.report-period')?.addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (input.name === `${prefix}-period`) dates.hidden = input.value !== 'custom';
    onChange();
  });
}

/** @param {any} row partner row or totals */
function numberCells(row) {
  /** @param {string} label @param {string} amount */
  const money = (label, amount) => `<td data-label="${esc(label)}">${esc(formatVnd(amount))}</td>`;
  return [
    `<td class="is-count" data-label="${esc(t('kpiRedemptions'))}">${esc(String(row.redemptions))}</td>`,
    money(t('dashBillTotal'), row.billTotal),
    money(t('reportDiscount'), row.discountTotal),
    ...COMMISSION.map((status) => money(t(`reportCommission_${status}`), row.commission[status])),
  ].join('');
}

/** @param {any} data */
function reportTable(data) {
  if (!data.partners.length) return `<p class="text-muted small mb-0">${esc(t('reportEmpty'))}</p>`;
  return `
    <table class="report-table">
      <thead>
        <tr>
          <th scope="col" rowspan="2">${esc(t('reportPartner'))}</th>
          <th scope="col" rowspan="2">${esc(t('kpiRedemptions'))}</th>
          <th scope="col" rowspan="2">${esc(t('dashBillTotal'))}</th>
          <th scope="col" rowspan="2">${esc(t('reportDiscount'))}</th>
          <th scope="colgroup" colspan="4" class="report-group">${esc(t('dashCommission'))}</th>
        </tr>
        <tr>${COMMISSION.map((status) => `<th scope="col">${esc(t(`reportStatus_${status}`))}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${data.partners.map((/** @type {any} */ row) => `<tr><th scope="row">${esc(row.name)}</th>${numberCells(row)}</tr>`).join('')}
      </tbody>
      <tfoot>
        <tr><th scope="row">${esc(t('reportTotal'))}</th>${numberCells(data.totals)}</tr>
      </tfoot>
    </table>`;
}

/**
 * @param {string} url CSV endpoint
 * @param {URLSearchParams | null} query
 * @param {string} slot message slot id
 * @param {HTMLButtonElement} button
 */
async function downloadCsv(url, query, slot, button) {
  if (!query) return showMessage(t('reportDatesInvalid'), 'error', slot);
  button.disabled = true;
  try {
    const { blob, fileName } = await apiFile(`${url}?${query}`);
    downloadBlob(blob, fileName);
    showMessage(t('reportDownloaded'), 'success', slot);
  } catch (error) {
    showMessage(reportError(error), 'error', slot);
  } finally {
    button.disabled = false;
  }
}

/** Console → Partners → Report (Merchant admin); hidden until opened. */
export function reportCard() {
  return `
    <section class="card-sw" id="partner-report-card" hidden>
      <div class="d-flex justify-content-between align-items-start gap-2">
        <h2 class="card-title mb-1">${esc(t('reportTitle'))}</h2>
        <button type="button" class="btn-close" data-report-close aria-label="${esc(t('close'))}"></button>
      </div>
      <p class="small text-muted mb-3">${esc(t('reportHint'))}</p>
      ${periodPicker('rp')}
      <p class="small text-muted mt-3 mb-2" id="rp-range" aria-live="polite"></p>
      <div id="rp-table"></div>
      <button type="button" class="btn btn-primary mt-3" id="rp-csv">${esc(t('reportExport'))}</button>
      ${messageSlot('rp-message')}
    </section>`;
}

/**
 * @param {ParentNode} root
 * @param {{ onToggle: (open: boolean) => void }} options
 */
export function mountReport(root, { onToggle }) {
  const card = /** @type {HTMLElement} */ (root.querySelector('#partner-report-card'));
  const pick = (/** @type {string} */ id) => /** @type {HTMLElement} */ (card.querySelector(`#${id}`));
  const load = async () => {
    const query = periodQuery(card, 'rp');
    if (!query) return showMessage(t('reportDatesInvalid'), 'error', 'rp-message');
    try {
      const data = await api('GET', `/api/v1/reports/commission?${query}`);
      pick('rp-range').textContent = t('reportRange', { from: formatDay(data.period.from), to: formatDay(data.period.to) });
      pick('rp-table').innerHTML = reportTable(data);
      showMessage('', 'info', 'rp-message');
    } catch (error) {
      showMessage(reportError(error), 'error', 'rp-message');
    }
  };
  bindPeriod(card, 'rp', load);
  const csv = /** @type {HTMLButtonElement} */ (pick('rp-csv'));
  csv.addEventListener('click', () => downloadCsv('/api/v1/reports/commission/csv', periodQuery(card, 'rp'), 'rp-message', csv));
  /** @param {boolean} open */
  const setOpen = (open) => {
    card.hidden = !open;
    onToggle(open);
    if (!open) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    load();
  };
  card.querySelector('[data-report-close]')?.addEventListener('click', () => setOpen(false));
  return setOpen;
}

/** MyConnect: the partner downloads its own bills of a period (no voucher codes). */
export function myReportCard() {
  return `
    <section class="card-sw" id="my-report">
      <h3 class="card-title">${esc(t('myReportTitle'))}</h3>
      <p class="small text-muted">${esc(t('myReportHint'))}</p>
      ${periodPicker('myr')}
      <button type="button" class="btn btn-primary w-100 mt-3" id="myr-csv">${esc(t('downloadCsv'))}</button>
      ${messageSlot('myr-message')}
    </section>`;
}

/** @param {ParentNode} root */
export function mountMyReport(root) {
  const card = /** @type {HTMLElement | null} */ (root.querySelector('#my-report'));
  if (!card) return;
  bindPeriod(card, 'myr', () => showMessage('', 'info', 'myr-message'));
  const button = /** @type {HTMLButtonElement} */ (card.querySelector('#myr-csv'));
  button.addEventListener('click', () => downloadCsv('/api/v1/my/partner/report/csv', periodQuery(card, 'myr'), 'myr-message', button));
}
