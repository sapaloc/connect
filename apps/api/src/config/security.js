import { ROLES } from '#domain';

// Plan §8: proposed values, pending Security sign-off. Change them here only.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SESSION_COOKIE = 'cx_session';

const HIGH_PRIVILEGE = new Set([ROLES.PLATFORM_ADMIN, ROLES.TENANT_ADMIN]);

/**
 * Sessions without a selected role use the stricter TTL.
 * @param {string | null | undefined} role
 */
export function sessionTtl(role) {
  return !role || HIGH_PRIVILEGE.has(role)
    ? { idleMs: 2 * HOUR, absoluteMs: 24 * HOUR }
    : { idleMs: 12 * HOUR, absoluteMs: 7 * DAY };
}

/** Sliding expiry is written at most this often per session. */
export const SESSION_TOUCH_INTERVAL_MS = MINUTE;

export const INVITATION_TTL_MS = 72 * HOUR;
export const PASSWORD_RESET_TTL_MS = HOUR;
/** A temporary password (approved merchant application) works until then; the admin can issue a new one. */
export const TEMP_PASSWORD_TTL_MS = 7 * DAY;

export const RATE_LIMITS = Object.freeze({
  loginAccount: { max: 5, windowMs: 15 * MINUTE },
  loginIp: { max: 20, windowMs: 15 * MINUTE },
  resetRequestEmail: { max: 3, windowMs: HOUR },
  resetRequestIp: { max: 10, windowMs: HOUR },
  tokenIp: { max: 10, windowMs: 15 * MINUTE },
  passwordChangeUser: { max: 5, windowMs: 15 * MINUTE },
  merchantApplicationIp: { max: 5, windowMs: HOUR },
  merchantApplicationEmail: { max: 3, windowMs: DAY },
  publicVoucherIp: { max: 60, windowMs: 15 * MINUTE },
  publicReferralIp: { max: 60, windowMs: 15 * MINUTE },
  referralActivateIp: { max: 20, windowMs: 15 * MINUTE },
  billPhotoIp: { max: 10, windowMs: 15 * MINUTE },
  // The guest voucher page polls every 2 s while visible; guests often share the merchant's wifi IP.
  confirmationPollBrowser: { max: 600, windowMs: 15 * MINUTE },
  confirmationPollIp: { max: 6000, windowMs: 15 * MINUTE },
  confirmationAnswerIp: { max: 60, windowMs: 15 * MINUTE },
});

/** scrypt cost: ~50 ms and 32 MiB per hash on a Vercel function. */
export const SCRYPT = Object.freeze({ N: 2 ** 15, r: 8, p: 1, keyLength: 64, maxmem: 64 * 1024 * 1024 });
