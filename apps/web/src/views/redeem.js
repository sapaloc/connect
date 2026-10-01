import { calculateDirectRedemption, displaySplit, FALLBACK_REASONS, formatVoucherCode, toVnd } from '#domain';
import { api } from '../api.js';
import { $, busy, esc } from '../dom.js';
import { errorText, formatDateTime, formatVnd, getLang, t } from '../i18n.js';
import { startPolling } from '../poll.js';
import { confirmQrDataUrl, discountText, termsText } from '../voucher-ui.js';
import { messageSlot, showMessage } from './common.js';
import { billPhotoField, bindBillPhoto, statusPill } from './voucher-card.js';

/** @typedef {import('../voucher-ui.js').Voucher} Voucher */
/**
 * @typedef {{
 *   id: string, code: string, status: 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED' | 'FALLBACK',
 *   grossAmount: string, discountAmount: string, payableAmount: string, expiresAt: string,
 *   confirmPath: string, voucher: Voucher | null,
 * }} Confirmation
 */

/**
 * Bill, discount and amount to pay in whole VND that add up on screen (plan §7.1 rule 3).
 * @param {{ grossAmount: string, discountAmount: string, payableAmount: string }} amounts
 */
export function amountRows(amounts) {
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

  const code = encodeURIComponent(voucher.code);
  const needsGuest = voucher.source === 'REFERRAL';
  let stopWatching = () => {};

  /** @param {Voucher} done @param {string} [note] shown under the title; no photo picker when set */
  const showDone = (done, note = '') => {
    stopWatching();
    root.innerHTML = `
      <section class="redeem redeem-done">
        <p class="redeem-ok">${esc(t('redeemDone'))}</p>
        <p class="redeem-code" translate="no">${esc(formatVoucherCode(done.code))}</p>
        ${note ? `<p class="small text-muted">${esc(note)}</p>` : ''}
        ${amountRows(/** @type {NonNullable<Voucher['redemption']>} */ (done.redemption))}
        ${note ? '' : `<div class="mb-3">${billPhotoField('staff-bill-file')}</div>`}
        <button type="button" class="btn btn-primary btn-lg w-100" data-next>${esc(t('nextCustomer'))}</button>
      </section>`;
    if (!note) bindBillPhoto(root, 'staff-bill-file', `/api/v1/vouchers/${code}/bill-photos`);
    root.querySelector('[data-next]')?.addEventListener('click', onDone);
  };

  /** @param {string} [prefill] bill digits typed before */
  const showForm = (prefill = '') => {
    stopWatching();
    root.innerHTML = `
      <section class="redeem">
        ${header}
        <form id="redeem-form" class="mt-3" novalidate>
          <label for="bill" class="form-label fw-semibold">${esc(t('billAmount'))}</label>
          <input id="bill" name="grossAmount" class="form-control form-control-lg" inputmode="numeric" autocomplete="off" required />
          <div id="redeem-preview" class="mt-3"></div>
          <button type="submit" class="btn btn-primary btn-lg w-100 mt-2">${esc(t(needsGuest ? 'sendToGuest' : 'confirmRedeem'))}</button>
          ${needsGuest ? `<p class="small text-muted mt-2 mb-0">${esc(t('sendToGuestHint'))}</p>` : ''}
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
    if (prefill) {
      bill.value = prefill;
      bill.dispatchEvent(new Event('input'));
    }
    bill.focus();

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      busy(form, async () => {
        try {
          if (needsGuest) {
            const { confirmation } = await api('POST', `/api/v1/vouchers/${code}/confirmations`, { grossAmount: digits() });
            showWaiting(confirmation);
            return;
          }
          const { voucher: done } = await api('POST', `/api/v1/vouchers/${code}/redeem`, { grossAmount: digits() });
          showDone(done);
        } catch (error) {
          showMessage(errorText(error), 'error', 'redeem-message');
        }
      });
    });
  };

  /**
   * Bill sent to the guest: QR for a guest holding only a picture, countdown, and a 2 s status poll.
   * @param {Confirmation} confirmation
   */
  const showWaiting = (confirmation) => {
    stopWatching();
    const prefill = toVnd(confirmation.grossAmount);
    root.innerHTML = `
      <section class="redeem">
        ${header}
        <p class="redeem-step mt-3" data-wait-title>${esc(t('confirmWaiting'))}</p>
        ${amountRows(confirmation)}
        <div data-wait-live>
          <p class="small text-muted">${esc(t('confirmWaitingHint'))}</p>
          <div class="confirm-qr"><img alt="${esc(t('confirmQrAlt'))}" width="200" height="200" /></div>
          <p class="small text-center fw-semibold mb-2" data-countdown></p>
        </div>
        <p class="form-message" data-tone="info" data-wait-status role="status" aria-live="polite"></p>
        <div class="d-grid gap-2" data-wait-actions></div>
      </section>`;
    confirmQrDataUrl(confirmation.confirmPath, 400).then((src) => {
      const img = /** @type {HTMLImageElement | null} */ (root.querySelector('.confirm-qr img'));
      if (img) img.src = src;
    });

    const live = $('[data-wait-live]', root);
    const status = $('[data-wait-status]', root);
    const actions = $('[data-wait-actions]', root);
    const countdown = $('[data-countdown]', root);
    /** @param {('cancel' | 'fallback' | 'resend' | 'edit')[]} names */
    const setActions = (names) => {
      const labels = { cancel: 'confirmCancel', fallback: 'guestCannotConfirm', resend: 'confirmResend', edit: 'confirmEditBill' };
      actions.innerHTML = names
        .map((name, i) => `<button type="button" class="btn ${i === 0 && name !== 'cancel' ? 'btn-primary' : 'btn-outline-secondary'}" data-act="${name}">${esc(t(labels[name]))}</button>`)
        .join('');
    };
    /** @param {string} key */
    const ended = (key, tone = 'error') => {
      stopWatching();
      live.hidden = true;
      status.dataset.tone = tone;
      status.textContent = t(key);
    };

    const tickClock = () => {
      const left = Math.max(0, new Date(confirmation.expiresAt).getTime() - Date.now());
      const s = Math.ceil(left / 1000);
      countdown.textContent = t('confirmTimeLeft', { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
    };
    tickClock();
    const clock = setInterval(tickClock, 1000);

    /** @param {Confirmation} current */
    const apply = (current) => {
      if (current.status === 'CONFIRMED' && current.voucher) return showDone(current.voucher, t('guestConfirmedStaff'));
      if (current.status === 'FALLBACK' && current.voucher) return showDone(current.voucher, t('fallbackDone'));
      if (current.status === 'DECLINED') {
        ended('confirmDeclinedStaff');
        setActions(['edit']);
      } else if (current.status === 'EXPIRED') {
        ended('confirmExpiredStaff');
        setActions(['resend', 'fallback', 'edit']);
      } else if (current.status === 'CANCELLED') {
        ended('confirmCancelledStaff');
        setActions(['edit']);
      }
    };

    const stopPolling = startPolling(async () => {
      if (!root.isConnected) return false;
      const { confirmation: current } = await api('GET', `/api/v1/confirmations/${confirmation.id}`);
      if (current.status === 'PENDING') return true;
      apply(current);
      return false;
    });
    stopWatching = () => {
      stopPolling();
      clearInterval(clock);
      stopWatching = () => {};
    };
    setActions(['cancel', 'fallback']);

    actions.addEventListener('click', async (event) => {
      const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('button[data-act]'));
      if (!button) return;
      const act = button.dataset.act;
      if (act === 'edit') return showForm(prefill);
      if (act === 'fallback') return showFallback(confirmation);
      button.disabled = true;
      try {
        if (act === 'cancel') {
          await api('POST', `/api/v1/confirmations/${confirmation.id}/cancel`, {}).catch(() => {});
          showForm(prefill);
        } else if (act === 'resend') {
          const { confirmation: next } = await api('POST', `/api/v1/vouchers/${code}/confirmations`, { grossAmount: prefill });
          showWaiting(next);
        }
      } catch (error) {
        status.dataset.tone = 'error';
        status.textContent = errorText(error);
        button.disabled = false;
      }
    });
  };

  /**
   * Guest cannot confirm: bill photo and a reason, then the redemption is recorded and the commission
   * waits for the Merchant admin.
   * @param {Confirmation} confirmation
   */
  const showFallback = (confirmation) => {
    stopWatching();
    root.innerHTML = `
      <section class="redeem">
        ${header}
        <p class="redeem-step mt-3">${esc(t('fallbackTitle'))}</p>
        ${amountRows(confirmation)}
        <p class="small text-muted">${esc(t('fallbackHint'))}</p>
        <form id="fallback-form" novalidate>
          <div class="mb-3">${billPhotoField('fallback-bill-file', t('fallbackPhotoRequired'))}</div>
          <label for="fallback-reason" class="form-label fw-semibold">${esc(t('fallbackReason'))}</label>
          <select id="fallback-reason" name="reason" class="form-select" required>
            <option value="">${esc(t('fallbackReasonPick'))}</option>
            ${FALLBACK_REASONS.map((reason) => `<option value="${reason}">${esc(t(`fallback_${reason}`))}</option>`).join('')}
          </select>
          <button type="submit" class="btn btn-primary btn-lg w-100 mt-3">${esc(t('fallbackSubmit'))}</button>
          <button type="button" class="btn btn-outline-secondary w-100 mt-2" data-back>${esc(t('fallbackBack'))}</button>
          ${messageSlot('fallback-message')}
        </form>
      </section>`;
    bindBillPhoto(root, 'fallback-bill-file', `/api/v1/vouchers/${code}/bill-photos`);
    root.querySelector('[data-back]')?.addEventListener('click', async () => {
      const { confirmation: current } = await api('GET', `/api/v1/confirmations/${confirmation.id}`).catch(() => ({ confirmation }));
      showWaiting(current);
    });
    const form = /** @type {HTMLFormElement} */ ($('#fallback-form', root));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      busy(form, async () => {
        const reason = /** @type {HTMLSelectElement} */ ($('#fallback-reason', root)).value;
        if (!reason) return showMessage(t('fallbackReasonMissing'), 'error', 'fallback-message');
        try {
          const { confirmation: done } = await api('POST', `/api/v1/confirmations/${confirmation.id}/fallback`, { reason });
          showDone(done.voucher, t('fallbackDone'));
        } catch (error) {
          if (/** @type {any} */ (error)?.details?.status === 'CONFIRMED') {
            const { confirmation: current } = await api('GET', `/api/v1/confirmations/${confirmation.id}`);
            return showDone(current.voucher, t('guestConfirmedStaff'));
          }
          showMessage(errorText(error), 'error', 'fallback-message');
        }
      });
    });
  };

  showForm();
}
