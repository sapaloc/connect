import { formatVoucherCode, ratePercent } from '#domain';
import QRCode from 'qrcode';
import { formatDate, formatVnd, t } from './i18n.js';

/**
 * @typedef {{
 *   code: string,
 *   merchantName: string | null,
 *   status: 'ACTIVE' | 'REDEEMED' | 'EXPIRED' | 'VOID',
 *   discountType: 'PERCENT' | 'AMOUNT',
 *   discountValue: string,
 *   minBillAmount: string | null,
 *   validUntil: string,
 *   customerName?: string | null,
 *   note?: string | null,
 *   batchId?: string | null,
 *   createdAt?: string,
 *   redemption?: { grossAmount: string, discountAmount: string, payableAmount: string, redeemedAt: string } | null,
 *   voidReason?: string | null,
 * }} Voucher
 */

/** @param {string} code */
export function voucherLink(code) {
  return `${location.origin}/v/${code}`;
}

/** @param {Pick<Voucher, 'discountType' | 'discountValue'>} voucher */
export function discountText(voucher) {
  return voucher.discountType === 'PERCENT'
    ? t('percentOff', { value: ratePercent(voucher.discountValue) })
    : t('amountOff', { amount: formatVnd(voucher.discountValue) });
}

/** @param {Voucher} voucher */
export function termsText(voucher) {
  return [
    t('validUntilShort', { date: formatDate(voucher.validUntil) }),
    voucher.minBillAmount ? t('minBillShort', { amount: formatVnd(voucher.minBillAmount) }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * QR of the public link, so any phone camera opens the voucher page and the counter scanner reads the code.
 * @param {string} code
 * @param {number} [size]
 */
export function qrDataUrl(code, size = 320) {
  return QRCode.toDataURL(voucherLink(code), { width: size, margin: 1, errorCorrectionLevel: 'M' });
}

/** @param {string} src */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 */
function fit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * A 1080x1350 PNG to save or send by Zalo / WhatsApp: merchant, discount, QR, code, terms.
 * @param {Voucher} voucher
 * @returns {Promise<Blob>}
 */
export async function voucherImage(voucher) {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  await document.fonts?.ready;
  const font = (/** @type {number} */ size, weight = 700) => `${weight} ${size}px "DM Sans", system-ui, sans-serif`;

  ctx.fillStyle = '#F4EFE9';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#28332C';
  ctx.fillRect(0, 0, W, 300);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = font(34, 500);
  ctx.fillText(t('voucherTitle').toUpperCase(), W / 2, 90);
  ctx.font = font(64);
  ctx.fillText(fit(ctx, voucher.merchantName ?? 'MyConnect', W - 120), W / 2, 180);
  ctx.font = font(30, 500);
  ctx.fillStyle = '#CFE3D6';
  ctx.fillText(fit(ctx, voucher.customerName ?? '', W - 120), W / 2, 245);

  ctx.fillStyle = '#C2410C';
  ctx.font = font(96);
  ctx.fillText(fit(ctx, discountText(voucher), W - 120), W / 2, 430);

  const qr = /** @type {HTMLImageElement} */ (await loadImage(await qrDataUrl(voucher.code, 560)));
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(W / 2 - 310, 490, 620, 620);
  ctx.drawImage(qr, W / 2 - 280, 520, 560, 560);

  ctx.fillStyle = '#17262D';
  ctx.font = font(72);
  ctx.fillText(formatVoucherCode(voucher.code), W / 2, 1200);
  ctx.font = font(32, 500);
  ctx.fillStyle = '#4B5563';
  ctx.fillText(fit(ctx, termsText(voucher), W - 120), W / 2, 1260);
  ctx.font = font(26, 500);
  ctx.fillText('MyConnect', W / 2, 1315);

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png'));
}

/**
 * @param {Blob} blob
 * @param {string} fileName
 */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Web Share with the image when the device supports files (phones: Zalo, WhatsApp, Messenger...);
 * otherwise the image is downloaded and the link copied.
 * @param {Voucher} voucher
 * @returns {Promise<'shared' | 'downloaded' | 'cancelled'>}
 */
export async function shareVoucher(voucher) {
  const blob = await voucherImage(voucher);
  const file = new File([blob], `voucher-${voucher.code}.png`, { type: 'image/png' });
  const text = `${voucher.merchantName ?? ''} · ${discountText(voucher)} · ${voucherLink(voucher.code)}`;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: t('voucherTitle'), text });
      return 'shared';
    } catch (error) {
      if (/** @type {Error} */ (error).name === 'AbortError') return 'cancelled';
    }
  }
  downloadBlob(blob, file.name);
  await navigator.clipboard?.writeText(voucherLink(voucher.code)).catch(() => {});
  return 'downloaded';
}

/**
 * CSV of a batch for printing or a mail merge. Excel opens UTF-8 correctly thanks to the BOM.
 * @param {Voucher[]} vouchers
 */
export function vouchersCsv(vouchers) {
  const cell = (/** @type {string} */ value) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [
    ['code', 'link', 'discount', 'valid_until', 'min_bill', 'customer', 'status'],
    ...vouchers.map((v) => [
      formatVoucherCode(v.code),
      voucherLink(v.code),
      discountText(v),
      formatDate(v.validUntil),
      v.minBillAmount ? formatVnd(v.minBillAmount) : '',
      v.customerName ?? '',
      v.status,
    ]),
  ];
  return new Blob([`\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
}
