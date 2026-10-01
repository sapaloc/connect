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
 *   source?: 'DIRECT' | 'REFERRAL',
 *   redemption?: { grossAmount: string, discountAmount: string, payableAmount: string, redeemedAt: string, confirmation?: 'GUEST' | 'UNCONFIRMED' | null } | null,
 *   voidReason?: string | null,
 *   brand?: Brand | null,
 *   billPhotos?: { id: string, addedBy: 'GUEST' | 'STAFF', addedAt: string, url: string }[],
 *   guestBillPhotos?: number,
 * }} Voucher
 * @typedef {{ logoUrl: string | null, color: string | null, textColor: string | null }} Brand
 */

/** @param {string} code */
export function voucherLink(code) {
  return `${location.origin}/v/${code}`;
}

/** @param {string} token partner QR token */
export function referralLink(token) {
  return `${location.origin}/r/${token}`;
}

/** @param {Pick<Voucher, 'discountType' | 'discountValue'>} voucher */
export function discountText(voucher) {
  return voucher.discountType === 'PERCENT'
    ? t('percentOff', { value: ratePercent(voucher.discountValue) })
    : t('amountOff', { amount: formatVnd(voucher.discountValue) });
}

/**
 * Guest discount of a partner rule as voucher terms: a fixed amount, or a percent on a rule from before phase 1.
 * @param {{ customerDiscountAmount?: string | null, customerDiscountRate?: string | null } | null | undefined} rule
 * @returns {Pick<Voucher, 'discountType' | 'discountValue'> | null}
 */
export function ruleDiscount(rule) {
  if (rule?.customerDiscountAmount) return { discountType: 'AMOUNT', discountValue: rule.customerDiscountAmount };
  if (rule?.customerDiscountRate && rule.customerDiscountRate !== '0.0000') return { discountType: 'PERCENT', discountValue: rule.customerDiscountRate };
  return null;
}

/**
 * Guest discount and partner commission of a rule, ready to show: VND amounts, or percents on a rule
 * from before phase 1.
 * @param {{ customerDiscountAmount?: string | null, commissionAmount?: string | null, customerDiscountRate?: string | null,
 *   commissionRate?: string | null, companyCommissionRate?: string | null, individualCommissionRate?: string | null }} rule
 */
export function ruleTerms(rule) {
  if (rule.customerDiscountAmount && rule.commissionAmount) {
    return { discount: formatVnd(rule.customerDiscountAmount), commission: formatVnd(rule.commissionAmount) };
  }
  const commission = rule.commissionRate ?? rule.companyCommissionRate ?? rule.individualCommissionRate ?? '0';
  return { discount: `${ratePercent(rule.customerDiscountRate ?? '0')}%`, commission: `${ratePercent(commission)}%` };
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

/**
 * @param {string} token
 * @param {number} [size]
 */
export function referralQrDataUrl(token, size = 320) {
  return QRCode.toDataURL(referralLink(token), { width: size, margin: 1, errorCorrectionLevel: 'M' });
}

/**
 * QR the counter shows so a guest holding only a picture of the voucher opens the bill on their phone.
 * @param {string} path e.g. /v/ABCD2345?confirm=<id>
 * @param {number} [size]
 */
export function confirmQrDataUrl(path, size = 320) {
  return QRCode.toDataURL(`${location.origin}${path}`, { width: size, margin: 1, errorCorrectionLevel: 'M' });
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

/** Card colours from the `main` design tokens (--sw-card, --sw-ink, --sw-acc, --sw-ink2). */
const CARD = '#FBF7EE';
const INK = '#1F2823';
const ACCENT = '#B8643F';
const INK_SOFT = '#3D4A41';

/**
 * The SAPAWOO wordmark (Georgia, letter-spaced) at the foot of a share image.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 */
function drawWordmark(ctx, x, y) {
  ctx.fillStyle = INK_SOFT;
  ctx.font = '30px Georgia, serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2.4px';
  ctx.fillText('SAPAWOO', x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

/**
 * Top band of a share image in the merchant colour. With a logo, the logo (on a white chip) takes
 * the place of the small eyebrow line.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ width: number, eyebrow: string, merchantName: string, sub: string, brand?: Brand | null }} options
 */
async function drawHeader(ctx, { width: W, eyebrow, merchantName, sub, brand }) {
  const font = (/** @type {number} */ size, weight = 700) => `${weight} ${size}px "DM Sans", system-ui, sans-serif`;
  const ink = brand?.textColor ?? '#FFFFFF';
  ctx.fillStyle = brand?.color ?? '#28332C';
  ctx.fillRect(0, 0, W, 300);
  ctx.textAlign = 'center';

  const logo = brand?.logoUrl ? /** @type {HTMLImageElement | null} */ (await loadImage(brand.logoUrl).catch(() => null)) : null;
  if (logo) {
    const scale = Math.min(320 / logo.naturalWidth, 80 / logo.naturalHeight);
    const w = logo.naturalWidth * scale;
    const h = logo.naturalHeight * scale;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(W / 2 - w / 2 - 20, 28, w + 40, h + 24, 16);
    ctx.fill();
    ctx.drawImage(logo, W / 2 - w / 2, 40, w, h);
  } else {
    ctx.fillStyle = ink;
    ctx.font = font(34, 500);
    ctx.fillText(eyebrow.toUpperCase(), W / 2, 90);
  }
  ctx.fillStyle = ink;
  ctx.font = font(64);
  ctx.fillText(fit(ctx, merchantName, W - 120), W / 2, 190);
  if (sub) {
    ctx.globalAlpha = 0.85;
    ctx.font = font(30, 500);
    ctx.fillText(fit(ctx, sub, W - 120), W / 2, 250);
    ctx.globalAlpha = 1;
  }
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

  ctx.fillStyle = CARD;
  ctx.fillRect(0, 0, W, H);
  await drawHeader(ctx, {
    width: W,
    eyebrow: t('voucherTitle'),
    merchantName: voucher.merchantName ?? 'MyConnect',
    sub: voucher.customerName ?? '',
    brand: voucher.brand,
  });

  ctx.fillStyle = ACCENT;
  ctx.font = font(96);
  ctx.fillText(fit(ctx, discountText(voucher), W - 120), W / 2, 430);

  const qr = /** @type {HTMLImageElement} */ (await loadImage(await qrDataUrl(voucher.code, 560)));
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(W / 2 - 310, 490, 620, 620);
  ctx.drawImage(qr, W / 2 - 280, 520, 560, 560);

  ctx.fillStyle = INK;
  ctx.font = font(72);
  ctx.fillText(formatVoucherCode(voucher.code), W / 2, 1200);
  ctx.font = font(32, 500);
  ctx.fillStyle = INK_SOFT;
  ctx.fillText(fit(ctx, termsText(voucher), W - 120), W / 2, 1260);
  drawWordmark(ctx, W / 2, 1318);

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png'));
}

/**
 * @typedef {{ token: string, merchantName: string, partnerName: string, discount: Pick<Voucher, 'discountType' | 'discountValue'> | null, brand?: Brand | null }} PartnerQr
 */

/**
 * A 1080x1350 PNG the partner prints or posts: merchant, discount, QR, "introduced by".
 * @param {PartnerQr} qr
 * @returns {Promise<Blob>}
 */
export async function partnerQrImage(qr) {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  await document.fonts?.ready;
  const font = (/** @type {number} */ size, weight = 700) => `${weight} ${size}px "DM Sans", system-ui, sans-serif`;

  ctx.fillStyle = CARD;
  ctx.fillRect(0, 0, W, H);
  await drawHeader(ctx, {
    width: W,
    eyebrow: t('referralOffer'),
    merchantName: qr.merchantName,
    sub: t('introducedBy', { name: qr.partnerName }),
    brand: qr.brand,
  });

  if (qr.discount) {
    ctx.fillStyle = ACCENT;
    ctx.font = font(96);
    ctx.fillText(fit(ctx, discountText(qr.discount), W - 120), W / 2, 430);
  }

  const image = /** @type {HTMLImageElement} */ (await loadImage(await referralQrDataUrl(qr.token, 560)));
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(W / 2 - 310, 490, 620, 620);
  ctx.drawImage(image, W / 2 - 280, 520, 560, 560);

  ctx.fillStyle = INK;
  ctx.font = font(44);
  ctx.fillText(fit(ctx, t('scanToGetVoucher'), W - 120), W / 2, 1200);
  ctx.font = font(30, 500);
  ctx.fillStyle = INK_SOFT;
  ctx.fillText(fit(ctx, t('referralTerms', { days: 7 }), W - 120), W / 2, 1260);
  drawWordmark(ctx, W / 2, 1318);

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png'));
}

/**
 * @param {PartnerQr} qr
 * @returns {Promise<'shared' | 'downloaded' | 'cancelled'>}
 */
export async function sharePartnerQr(qr) {
  const blob = await partnerQrImage(qr);
  const slug = qr.partnerName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const file = new File([blob], `qr-${slug || 'partner'}.png`, { type: 'image/png' });
  const text = `${qr.merchantName} · ${t('introducedBy', { name: qr.partnerName })} · ${referralLink(qr.token)}`;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: qr.merchantName, text });
      return 'shared';
    } catch (error) {
      if (/** @type {Error} */ (error).name === 'AbortError') return 'cancelled';
    }
  }
  downloadBlob(blob, file.name);
  await navigator.clipboard?.writeText(referralLink(qr.token)).catch(() => {});
  return 'downloaded';
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
