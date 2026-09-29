import { calculateDirectRedemption, displaySplit, formatVoucherCode } from '#domain';
import { api } from '../api.js';
import { $, busy, esc } from '../dom.js';
import { errorText, formatDateTime, formatVnd, getLang, t } from '../i18n.js';
import { discountText, termsText } from '../voucher-ui.js';
import { messageSlot, showMessage } from './common.js';
import { statusPill } from './voucher-card.js';

/** @typedef {import('../voucher-ui.js').Voucher} Voucher */

/**
 * Bill, discount and amount to pay in whole VND that add up on screen (plan §7.1 rule 3).
 * @param {{ grossAmount: string, discountAmount: string, payableAmount: string }} amounts
 */
function amountRows(amounts) {
  const shown = displaySplit(amounts.grossAmount, [amounts.discountAmount, amounts.payableAmount]);
  const vnd = (/** @type {string} */ value) => formatVnd(value);
  return `
    <dl class="amounts">
      <div><dt>${esc(t('billAmount'))}</dt><dd>${esc(vnd(shown.total))}</dd></div>
      <div><dt>${esc(t('discountLine'))}</dt><dd>− ${esc(vnd(shown.parts[0]))}</dd></div>
      <div class="amounts-total"><dt>${esc(t('customerPays'))}</dt><dd>${esc(vnd(shown.parts[1]))}</dd></div>
    </dl>`;
}

/**
 * Voucher summary + bill form for counter roles. `onDone` runs after "Next customer".
 * @param {HTMLElement} root
 * @param {Voucher} voucher
 * @param {() => void} onDone
 */
export function mountRedeem(root, voucher, onDone) {
  const header = `
    <div class="redeem-head">
      <div>
        <p class="redeem-code" translate="no">${esc(formatVoucherCode(voucher.code))}</p>
        <p class="redeem-discount">${esc(discountText(voucher))}</p>
        <p class="small text-muted mb-0">${esc(termsText(voucher))}</p>
        ${voucher.customerName ? `<p class="small mb-0">${esc(t('customerName'))}: <strong>${esc(voucher.customerName)}</strong></p>` : ''}
        ${voucher.note ? `<p class="small text-muted mb-0">${esc(t('note'))}: ${esc(voucher.note)}</p>` : ''}
      </div>
      <div>${statusPill(voucher)}</div>
    </div>`;

  if (voucher.status !== 'ACTIVE') {
    root.innerHTML = `
      <section class="redeem">
        ${header}
        <p class="form-message mt-3" data-tone="error">${esc(t(`vnote_${voucher.status}`))}${
          voucher.redemption ? ` ${esc(t('redeemedOn', { date: formatDateTime(voucher.redemption.redeemedAt) }))}` : ''
        }</p>
        <button type="button" class="btn btn-outline-secondary w-100" data-next>${esc(t('nextCustomer'))}</button>
      </section>`;
    root.querySelector('[data-next]')?.addEventListener('click', onDone);
    return;
  }

  root.innerHTML = `
    <section class="redeem">
      ${header}
      <form id="redeem-form" class="mt-3" novalidate>
        <label for="bill" class="form-label fw-semibold">${esc(t('billAmount'))}</label>
        <input id="bill" name="grossAmount" class="form-control form-control-lg" inputmode="numeric" autocomplete="off" required />
        <div id="redeem-preview" class="mt-3"></div>
        <button type="submit" class="btn btn-primary btn-lg w-100 mt-2">${esc(t('confirmRedeem'))}</button>
        ${messageSlot('redeem-message')}
      </form>
    </section>`;

  const form = /** @type {HTMLFormElement} */ ($('#redeem-form', root));
  const bill = /** @type {HTMLInputElement} */ ($('#bill', root));
  const digits = () => bill.value.replace(/\D/g, '');

  bill.addEventListener('input', () => {
    const value = digits();
    bill.value = value ? Number(value).toLocaleString(getLang() === 'vi' ? 'vi-VN' : 'en-US') : '';
    const preview = $('#redeem-preview', root);
    try {
      preview.innerHTML = value
        ? amountRows(
            calculateDirectRedemption({
              discountType: voucher.discountType,
              discountValue: voucher.discountValue,
              minBillAmount: voucher.minBillAmount,
              grossAmount: value,
            }),
          )
        : '';
      showMessage('', 'info', 'redeem-message');
    } catch (error) {
      preview.innerHTML = '';
      showMessage(errorText(error), 'error', 'redeem-message');
    }
  });
  bill.focus();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(form, async () => {
      try {
        const { voucher: done } = await api('POST', `/api/v1/vouchers/${encodeURIComponent(voucher.code)}/redeem`, { grossAmount: digits() });
        root.innerHTML = `
          <section class="redeem redeem-done">
            <p class="redeem-ok">${esc(t('redeemDone'))}</p>
            <p class="redeem-code" translate="no">${esc(formatVoucherCode(done.code))}</p>
            ${amountRows(done.redemption)}
            <button type="button" class="btn btn-primary btn-lg w-100" data-next>${esc(t('nextCustomer'))}</button>
          </section>`;
        root.querySelector('[data-next]')?.addEventListener('click', onDone);
      } catch (error) {
        showMessage(errorText(error), 'error', 'redeem-message');
      }
    });
  });
}
