import { formatVoucherCode } from '#domain';
import { esc } from '../dom.js';
import { formatDateTime, t } from '../i18n.js';
import { discountText, downloadBlob, qrDataUrl, shareVoucher, termsText, voucherImage, voucherLink } from '../voucher-ui.js';

/** @typedef {import('../voucher-ui.js').Voucher} Voucher */

/** @param {Voucher} voucher */
export function statusPill(voucher) {
  return `<span class="pill pill-${esc(voucher.status.toLowerCase())}">${esc(t(`vstatus_${voucher.status}`))}</span>`;
}

/**
 * The voucher as the customer sees it. The QR is filled in by fillQr once in the DOM.
 * @param {Voucher} voucher
 * @param {{ showCustomer?: boolean }} [options]
 */
export function voucherCard(voucher, { showCustomer = false } = {}) {
  const active = voucher.status === 'ACTIVE';
  return `
    <article class="vcard${active ? '' : ' vcard-off'}">
      <header class="vcard-head">
        <span class="vcard-eyebrow">${esc(t('voucherTitle'))}</span>
        <span class="vcard-merchant" translate="no">${esc(voucher.merchantName ?? 'MyConnect')}</span>
        ${showCustomer && voucher.customerName ? `<span class="vcard-customer">${esc(voucher.customerName)}</span>` : ''}
      </header>
      <div class="vcard-body">
        <p class="vcard-discount">${esc(discountText(voucher))}</p>
        <div class="vcard-qr"><img data-qr="${esc(voucher.code)}" alt="QR ${esc(formatVoucherCode(voucher.code))}" width="220" height="220" /></div>
        <p class="vcard-code" translate="no">${esc(formatVoucherCode(voucher.code))}</p>
        <p class="vcard-terms">${esc(termsText(voucher))}</p>
        <div>${statusPill(voucher)}</div>
        ${active ? '' : `<p class="vcard-note">${esc(t(`vnote_${voucher.status}`))}${
          voucher.redemption ? ` ${esc(t('redeemedOn', { date: formatDateTime(voucher.redemption.redeemedAt) }))}` : ''
        }</p>`}
      </div>
    </article>`;
}

/** @param {ParentNode} root */
export async function fillQr(root) {
  await Promise.all(
    [...root.querySelectorAll('img[data-qr]')].map(async (img) => {
      /** @type {HTMLImageElement} */ (img).src = await qrDataUrl(img.getAttribute('data-qr') ?? '', 440);
    }),
  );
}

/**
 * Share / download / copy buttons for one voucher.
 * @param {Voucher} voucher
 */
export function voucherActions(voucher) {
  return `
    <div class="vcard-actions">
      <button type="button" class="btn btn-primary" data-vshare>${esc(t('share'))}</button>
      <button type="button" class="btn btn-outline-secondary" data-vdownload>${esc(t('downloadImage'))}</button>
      <button type="button" class="btn btn-outline-secondary" data-vcopy>${esc(t('copyLink'))}</button>
    </div>
    <p class="small text-muted mt-2 mb-0" data-vmessage role="status" aria-live="polite"></p>`;
}

/**
 * @param {ParentNode} root
 * @param {Voucher} voucher
 */
export function bindVoucherActions(root, voucher) {
  const message = /** @type {HTMLElement} */ (root.querySelector('[data-vmessage]'));
  root.querySelector('[data-vshare]')?.addEventListener('click', async () => {
    if ((await shareVoucher(voucher)) === 'downloaded') message.textContent = t('imageDownloaded');
  });
  root.querySelector('[data-vdownload]')?.addEventListener('click', async () => {
    downloadBlob(await voucherImage(voucher), `voucher-${voucher.code}.png`);
  });
  root.querySelector('[data-vcopy]')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(voucherLink(voucher.code));
    message.textContent = t('copied');
  });
}

/**
 * Voucher detail in a native dialog (Escape and the close button dismiss it).
 * @param {Voucher} voucher
 */
export function openVoucherDialog(voucher) {
  let dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById('voucher-dialog'));
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'voucher-dialog';
    dialog.className = 'vdialog';
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || /** @type {HTMLElement} */ (event.target).closest('[data-vclose]')) dialog?.close();
    });
    document.body.append(dialog);
  }
  dialog.innerHTML = `
    <div class="vdialog-inner">
      <button type="button" class="btn-close vdialog-close" data-vclose aria-label="${esc(t('close'))}"></button>
      ${voucherCard(voucher, { showCustomer: true })}
      ${voucher.note ? `<p class="small text-muted mt-3 mb-0">${esc(t('note'))}: ${esc(voucher.note)}</p>` : ''}
      ${voucher.voidReason ? `<p class="small text-muted mt-1 mb-0">${esc(t('voidAction'))}: ${esc(voucher.voidReason)}</p>` : ''}
      ${voucher.status === 'ACTIVE' ? voucherActions(voucher) : ''}
    </div>`;
  fillQr(dialog);
  bindVoucherActions(dialog, voucher);
  dialog.showModal();
}
