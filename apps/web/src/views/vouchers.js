import { formatVoucherCode, VOUCHER_BATCH_MAX } from '#domain';
import { api } from '../api.js';
import { $, busy, esc, formValues } from '../dom.js';
import { errorText, formatDate, t } from '../i18n.js';
import { discountText, downloadBlob, vouchersCsv } from '../voucher-ui.js';
import { messageSlot, showMessage } from './common.js';
import { bindVoucherActions, fillQr, openVoucherDialog, statusPill, voucherActions, voucherCard } from './voucher-card.js';

/** @typedef {import('../main.js').App} App */
/** @typedef {import('../voucher-ui.js').Voucher} Voucher */

const STATUSES = /** @type {const} */ (['ACTIVE', 'REDEEMED', 'EXPIRED', 'VOID']);

/** YYYY-MM-DD in Vietnam, `days` from today. */
function vnDate(days) {
  return new Date(Date.now() + 7 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

/** @param {string} label */
const optionalLabel = (label) => `${esc(label)} <span class="text-muted">(${esc(t('optional'))})</span>`;

function issueForm() {
  return `
    <section class="card-sw">
      <h2 class="card-title">${esc(t('voucherCreateTitle'))}</h2>
      <p class="text-muted small mb-3">${esc(t('voucherCreateSubtitle'))}</p>
      <form id="voucher-issue" class="row g-3" novalidate>
        <div class="col-12">
          <div class="btn-group w-100" role="group" aria-label="${esc(t('discount'))}">
            <input type="radio" class="btn-check" name="discountType" id="dt-percent" value="PERCENT" checked />
            <label class="btn btn-outline-secondary" for="dt-percent">${esc(t('discountPercent'))}</label>
            <input type="radio" class="btn-check" name="discountType" id="dt-amount" value="AMOUNT" />
            <label class="btn btn-outline-secondary" for="dt-amount">${esc(t('discountAmount'))}</label>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <label for="v-value" class="form-label small">${esc(t('discountValue'))}</label>
          <div class="input-group">
            <input id="v-value" name="discountValue" class="form-control" inputmode="decimal" required />
            <span class="input-group-text" id="v-unit">%</span>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <label for="v-min" class="form-label small">${optionalLabel(t('minBill'))}</label>
          <input id="v-min" name="minBillAmount" class="form-control" inputmode="numeric" />
        </div>
        <div class="col-7 col-md-3">
          <label for="v-until" class="form-label small">${esc(t('validUntil'))}</label>
          <input id="v-until" name="validUntil" type="date" class="form-control" value="${vnDate(30)}" min="${vnDate(0)}" max="${vnDate(365)}" required />
        </div>
        <div class="col-5 col-md-3">
          <label for="v-qty" class="form-label small">${esc(t('quantity'))}</label>
          <input id="v-qty" name="quantity" type="number" class="form-control" value="1" min="1" max="${VOUCHER_BATCH_MAX}" required />
        </div>
        <div class="col-12 col-md-6">
          <label for="v-customer" class="form-label small">${optionalLabel(t('customerName'))}</label>
          <input id="v-customer" name="customerName" class="form-control" maxlength="120" />
        </div>
        <div class="col-12 col-md-6">
          <label for="v-note" class="form-label small">${optionalLabel(t('note'))}</label>
          <input id="v-note" name="note" class="form-control" maxlength="500" />
        </div>
        <div class="col-12 col-md-4 d-grid">
          <button type="submit" class="btn btn-primary">${esc(t('voucherCreate'))}</button>
        </div>
      </form>
      ${messageSlot('issue-message')}
      <div id="issue-result"></div>
    </section>`;
}

/** @param {App} app */
export function vouchersPanel(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const platform = profile.activeRole?.role === 'PLATFORM_ADMIN';
  return `
    ${profile.permissions.includes('voucher.issue') ? issueForm() : ''}
    <section class="grid-kpi" id="voucher-kpis" aria-live="polite"></section>
    <section class="card-sw">
      <h2 class="card-title">${esc(t('voucherListTitle'))}</h2>
      <div class="row g-2 mb-3">
        <div class="col-12 col-md-5">
          <input id="v-search" type="search" class="form-control" placeholder="${esc(t('voucherSearch'))}" aria-label="${esc(t('voucherSearch'))}" />
        </div>
        <div class="col-6 col-md-3">
          <select id="v-status" class="form-select" aria-label="${esc(t('status'))}">
            <option value="">${esc(t('allStatuses'))}</option>
            ${STATUSES.map((s) => `<option value="${s}">${esc(t(`vstatus_${s}`))}</option>`).join('')}
          </select>
        </div>
        ${
          platform
            ? `<div class="col-6 col-md-4">
                <select id="v-merchant" class="form-select" aria-label="${esc(t('merchant'))}">
                  <option value="">${esc(t('allMerchants'))}</option>
                </select>
              </div>`
            : ''
        }
      </div>
      <div class="table-responsive">
        <table class="table tbl tbl-stack align-middle mb-0">
          <thead>
            <tr>
              <th>${esc(t('code'))}</th>
              ${platform ? `<th>${esc(t('merchant'))}</th>` : ''}
              <th>${esc(t('discount'))}</th>
              <th>${esc(t('expiry'))}</th>
              <th>${esc(t('status'))}</th>
              <th class="text-end">${esc(t('actions'))}</th>
            </tr>
          </thead>
          <tbody id="voucher-rows"></tbody>
        </table>
      </div>
      <p class="small text-muted mt-2 mb-0" id="voucher-limit"></p>
      ${messageSlot('voucher-message')}
    </section>`;
}

/** @param {App} app */
export function mountVouchers(app) {
  const profile = /** @type {import('../api.js').Profile} */ (app.state.profile);
  const platform = profile.activeRole?.role === 'PLATFORM_ADMIN';
  const canVoid = profile.permissions.includes('voucher.void');
  /** @type {Voucher[]} */
  let vouchers = [];

  const renderKpis = (/** @type {Record<string, number>} */ counts) => {
    $('#voucher-kpis').innerHTML = STATUSES.map(
      (s) => `
      <button type="button" class="kpi kpi-btn" data-kpi="${s}">
        <span class="kpi-label">${esc(t(`vstatus_${s}`))}</span>
        <span class="kpi-value">${counts[s] ?? 0}</span>
      </button>`,
    ).join('');
  };

  const renderRows = () => {
    $('#voucher-rows').innerHTML = vouchers.length
      ? vouchers
          .map(
            (v) => `
        <tr>
          <td>
            <span class="d-block fw-semibold font-monospace" translate="no">${esc(formatVoucherCode(v.code))}</span>
            ${v.customerName ? `<span class="d-block small text-muted">${esc(v.customerName)}</span>` : ''}
          </td>
          ${platform ? `<td data-label="${esc(t('merchant'))}">${esc(v.merchantName ?? '')}</td>` : ''}
          <td data-label="${esc(t('discount'))}">${esc(discountText(v))}</td>
          <td data-label="${esc(t('expiry'))}">${esc(formatDate(v.validUntil))}</td>
          <td data-label="${esc(t('status'))}">${statusPill(v)}</td>
          <td class="text-md-end">
            <div class="d-flex flex-wrap gap-2 justify-content-md-end">
              <button type="button" class="btn btn-sm btn-outline-secondary" data-view="${esc(v.code)}">${esc(t('view'))}</button>
              ${canVoid && v.status === 'ACTIVE' ? `<button type="button" class="btn btn-sm btn-outline-danger" data-void="${esc(v.code)}">${esc(t('voidAction'))}</button>` : ''}
            </div>
          </td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="${platform ? 6 : 5}" class="text-muted">${esc(t('noVouchers'))}</td></tr>`;
  };

  const load = async () => {
    const params = new URLSearchParams();
    const q = /** @type {HTMLInputElement} */ ($('#v-search')).value.trim();
    const status = /** @type {HTMLSelectElement} */ ($('#v-status')).value;
    const merchant = /** @type {HTMLSelectElement | null} */ (document.getElementById('v-merchant'))?.value;
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (merchant) params.set('merchantId', merchant);
    try {
      const result = await api('GET', `/api/v1/vouchers?${params}`);
      vouchers = result.vouchers;
      renderKpis(result.counts);
      renderRows();
      $('#voucher-limit').textContent = vouchers.length >= result.limit ? t('listLimited', { limit: result.limit }) : '';
    } catch (error) {
      showMessage(errorText(error), 'error', 'voucher-message');
    }
  };

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let searchTimer;
  $('#v-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });
  $('#v-status').addEventListener('change', load);
  document.getElementById('v-merchant')?.addEventListener('change', load);

  $('#voucher-kpis').addEventListener('click', (event) => {
    const kpi = /** @type {HTMLElement} */ (event.target).closest('[data-kpi]');
    if (!kpi) return;
    /** @type {HTMLSelectElement} */ ($('#v-status')).value = kpi.getAttribute('data-kpi') ?? '';
    load();
  });

  $('#voucher-rows').addEventListener('click', async (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('button');
    if (!button) return;
    const viewCode = button.getAttribute('data-view');
    if (viewCode) {
      const voucher = vouchers.find((v) => v.code === viewCode);
      if (voucher) openVoucherDialog(voucher);
      return;
    }
    const voidCode = button.getAttribute('data-void');
    if (!voidCode) return;
    const reason = prompt(t('voidPrompt', { code: formatVoucherCode(voidCode) }))?.trim();
    if (!reason) return;
    try {
      await api('POST', `/api/v1/vouchers/${encodeURIComponent(voidCode)}/void`, { reason });
      await load();
    } catch (error) {
      showMessage(errorText(error), 'error', 'voucher-message');
    }
  });

  const form = /** @type {HTMLFormElement | null} */ (document.getElementById('voucher-issue'));
  if (form) {
    form.addEventListener('change', (event) => {
      if (/** @type {HTMLInputElement} */ (event.target).name === 'discountType') {
        $('#v-unit').textContent = formValues(form).discountType === 'PERCENT' ? '%' : '₫';
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      busy(form, async () => {
        showMessage('', 'info', 'issue-message');
        const values = formValues(form);
        try {
          const result = await api('POST', '/api/v1/vouchers', {
            discountType: values.discountType,
            discountValue:
              values.discountType === 'AMOUNT' ? values.discountValue.replace(/\D/g, '') : values.discountValue.replace(/\s/g, '').replace(',', '.'),
            minBillAmount: values.minBillAmount.replace(/\D/g, ''),
            validUntil: values.validUntil,
            quantity: Number(values.quantity),
            customerName: values.customerName,
            note: values.note,
          });
          showIssued(result.vouchers);
          form.reset();
          $('#v-unit').textContent = '%';
          /** @type {HTMLInputElement} */ ($('#v-until')).value = vnDate(30);
          await load();
        } catch (error) {
          showMessage(errorText(error), 'error', 'issue-message');
        }
      });
    });
  }

  /** @param {Voucher[]} issued */
  const showIssued = (issued) => {
    const box = $('#issue-result');
    showMessage(t('vouchersCreated', { count: issued.length }), 'success', 'issue-message');
    if (issued.length === 1) {
      box.innerHTML = `<div class="issued-one">${voucherCard(issued[0], { showCustomer: true })}${voucherActions(issued[0])}</div>`;
      fillQr(box);
      bindVoucherActions(box, issued[0]);
      return;
    }
    box.innerHTML = `
      <div class="issued-batch">
        <button type="button" class="btn btn-primary" data-csv>${esc(t('downloadCsv'))}</button>
        <div class="code-chips">
          ${issued.map((v) => `<button type="button" class="code-chip" data-chip="${esc(v.code)}" translate="no">${esc(formatVoucherCode(v.code))}</button>`).join('')}
        </div>
      </div>`;
    box.querySelector('[data-csv]')?.addEventListener('click', () => downloadBlob(vouchersCsv(issued), `vouchers-${issued[0].batchId ?? 'batch'}.csv`));
    box.querySelector('.code-chips')?.addEventListener('click', (event) => {
      const code = /** @type {HTMLElement} */ (event.target).closest('[data-chip]')?.getAttribute('data-chip');
      const voucher = issued.find((v) => v.code === code);
      if (voucher) openVoucherDialog(voucher);
    });
  };

  if (platform) {
    api('GET', '/api/v1/merchants')
      .then(({ merchants }) => {
        const select = /** @type {HTMLSelectElement} */ ($('#v-merchant'));
        select.insertAdjacentHTML(
          'beforeend',
          merchants.map((/** @type {{ id: string, name: string }} */ m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join(''),
        );
      })
      .catch(() => {});
  }

  load();
}
