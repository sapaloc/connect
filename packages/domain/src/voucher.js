/** No 0/O/1/I, so a code read aloud or typed from a photo is unambiguous. */
export const VOUCHER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const VOUCHER_CODE_LENGTH = 8;
export const VOUCHER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
export const VOUCHER_BATCH_MAX = 200;

export const VOUCHER_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  REDEEMED: 'REDEEMED',
  EXPIRED: 'EXPIRED',
  VOID: 'VOID',
});

/**
 * Accepts a typed code ("abcd-efgh", " ABCD EFGH ") or a scanned link ending in /v/<code>.
 * @param {unknown} input
 * @returns {string | null} the canonical 8-character code, or null when it is not a voucher code
 */
export function parseVoucherCode(input) {
  let value = String(input ?? '').trim();
  const link = /\/v\/([A-Za-z0-9-]+)\/?(?:[?#].*)?$/.exec(value);
  if (link) value = link[1];
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  return VOUCHER_CODE_PATTERN.test(code) ? code : null;
}

/** A referral voucher is valid 7 × 24 h from activation (plan §9.6). */
export const REFERRAL_VALIDITY_DAYS = 7;

/** Opaque public token of a partner QR: 16 random bytes, base64url. */
export const REFERRAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Accepts a scanned partner QR link ending in /r/<token>, or the bare token.
 * @param {unknown} input
 * @returns {string | null}
 */
export function parseReferralToken(input) {
  let value = String(input ?? '').trim();
  const link = /\/r\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(value);
  if (link) value = link[1];
  return REFERRAL_TOKEN_PATTERN.test(value) ? value : null;
}

/** @param {string} code "ABCDEFGH" -> "ABCD-EFGH" */
export function formatVoucherCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Stored status plus expiry: an ACTIVE voucher past its end is shown and treated as EXPIRED.
 * @param {string} status
 * @param {Date | string} validUntil
 * @param {Date} [now]
 */
export function effectiveVoucherStatus(status, validUntil, now = new Date()) {
  return status === VOUCHER_STATUSES.ACTIVE && new Date(validUntil).getTime() <= now.getTime() ? VOUCHER_STATUSES.EXPIRED : status;
}
