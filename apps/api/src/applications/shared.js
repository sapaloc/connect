import { ROLES } from '#domain';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import { consume } from '../auth/rate-limit.js';
import { newTemporaryPassword } from '../auth/temporary-password.js';
import { RATE_LIMITS, TEMP_PASSWORD_TTL_MS } from '../config/security.js';
import { collection } from '../db/mongo.js';
import { HttpError } from '../http/errors.js';
import { clientIp, stringField } from '../http/request.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const LANGUAGES = ['en', 'vi'];
export const RECEIVED = Object.freeze({ ok: true, status: 'PENDING' });
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
const REASON_MAX = 500;

/** @param {any} error */
export const isDuplicateKey = (error) => error?.code === 11000;

export const emailHasAccount = () => new HttpError(409, 'EMAIL_HAS_ACCOUNT', 'This email already has an account');
export const applicationPending = () =>
  new HttpError(409, 'APPLICATION_PENDING', 'An application with this email or business is already waiting for review');
const notFound = () => new HttpError(404, 'APPLICATION_NOT_FOUND', 'Application not found');
const notPending = () => new HttpError(409, 'APPLICATION_NOT_PENDING', 'This application was already reviewed');

/** A bot filled the hidden `website` field: answer as usual, store nothing. @param {Record<string, unknown>} body */
export function isHoneypotFilled(body) {
  return body.website !== undefined && body.website !== '';
}

/**
 * Per-IP limit, checked before reading the body. Both application kinds share the counter.
 * @param {import('node:http').IncomingMessage} req
 */
export async function limitApplicationsByIp(req) {
  await consume(`apply:ip:${clientIp(req)}`, RATE_LIMITS.applicationIp);
}

/** Per-email limit; both application kinds share the counter. @param {string} email */
export async function limitApplicationsByEmail(email) {
  await consume(`apply:email:${email}`, RATE_LIMITS.applicationEmail);
}

/** @param {Record<string, unknown>} body */
export function assertTermsAccepted(body) {
  if (body.acceptTerms !== true) {
    throw new HttpError(422, 'TERMS_NOT_ACCEPTED', 'The terms must be accepted', { details: { field: 'acceptTerms' } });
  }
}

/** @param {Record<string, unknown>} body */
export function parseReason(body) {
  const reason = stringField(body, 'reason', { max: REASON_MAX }).trim();
  if (!reason) throw new HttpError(422, 'VALIDATION', 'reason is required', { details: { field: 'reason' } });
  return reason;
}

/** `?status=` of a list request, PENDING by default. @param {import('node:http').IncomingMessage} req */
export function listStatus(req) {
  const status = new URL(req.url ?? '/', 'http://localhost').searchParams.get('status') || 'PENDING';
  if (!STATUSES.includes(status)) throw new HttpError(422, 'VALIDATION', 'status is invalid', { details: { field: 'status' } });
  return status;
}

/**
 * Refuses an email that already has an account or waits in a merchant or partner application.
 * The pending-unique indexes catch a race between two submits of the same kind.
 * @param {string} email
 * @param {import('mongodb').ClientSession} [tx]
 */
export async function assertEmailFree(email, tx) {
  const users = await collection('users');
  if (await users.countDocuments({ email }, { session: tx, limit: 1 })) throw emailHasAccount();
  const [merchants, partners] = await Promise.all([collection('merchantApplications'), collection('partnerApplications')]);
  const pending = await Promise.all([
    merchants.countDocuments({ status: 'PENDING', 'admin.email': email }, { session: tx, limit: 1 }),
    partners.countDocuments({ status: 'PENDING', email }, { session: tx, limit: 1 }),
  ]);
  if (pending.some(Boolean)) throw applicationPending();
}

/**
 * @param {'merchantApplications' | 'partnerApplications'} kind
 * @param {string} rawId
 * @param {import('mongodb').ClientSession} tx
 */
export async function pendingApplication(kind, rawId, tx) {
  const id = rawId.toLowerCase();
  if (!UUID_PATTERN.test(id)) throw notFound();
  const applications = await collection(kind);
  const application = await applications.findOne({ _id: id }, { session: tx });
  if (!application) throw notFound();
  if (application.status !== 'PENDING') throw notPending();
  return application;
}

/**
 * @param {'merchantApplications' | 'partnerApplications'} kind
 * @param {import('mongodb').ClientSession} tx
 * @param {string} id
 * @param {Record<string, unknown>} set
 */
export async function closeApplication(kind, tx, id, set) {
  const applications = await collection(kind);
  const { modifiedCount } = await applications.updateOne({ _id: id, status: 'PENDING' }, { $set: { ...set, updatedAt: new Date() } }, { session: tx });
  if (modifiedCount !== 1) throw notPending();
}

/**
 * Active Platform admins, for the "new application" notice, each in their own language.
 * @returns {Promise<import('../notify/notify.js').Recipient[]>}
 */
export async function platformAdminRecipients() {
  const users = await collection('users');
  const rows = await users
    .find(
      { status: 'ACTIVE', roles: { $elemMatch: { role: ROLES.PLATFORM_ADMIN, status: 'ACTIVE' } } },
      { projection: { email: 1, preferredLanguage: 1 } },
    )
    .toArray();
  return rows.map((user) => ({ email: user.email, language: user.preferredLanguage === 'vi' ? 'vi' : 'en' }));
}

/** Hashed outside the transaction: scrypt is slow and the transaction should stay short. */
export async function temporaryCredentials() {
  const temporaryPassword = newTemporaryPassword();
  return { temporaryPassword, passwordHash: await hashPassword(temporaryPassword) };
}

/**
 * Inserts an ACTIVE account that must replace its temporary password at first sign-in.
 * @param {{ email: string, displayName: string, preferredLanguage: string, passwordHash: string, roles: any[] }} account
 * @param {import('mongodb').ClientSession} tx
 */
export async function insertTemporaryAccount({ email, displayName, preferredLanguage, passwordHash, roles }, tx) {
  const users = await collection('users');
  if (await users.countDocuments({ email }, { session: tx, limit: 1 })) throw emailHasAccount();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TEMP_PASSWORD_TTL_MS);
  const userId = randomUUID();
  try {
    await users.insertOne(
      {
        _id: userId,
        email,
        displayName,
        status: 'ACTIVE',
        preferredLanguage,
        passwordHash,
        passwordChangedAt: now,
        mustChangePassword: true,
        tempPasswordExpiresAt: expiresAt,
        roles,
        createdAt: now,
        updatedAt: now,
      },
      { session: tx },
    );
  } catch (error) {
    if (isDuplicateKey(error)) throw emailHasAccount();
    throw error;
  }
  return { userId, expiresAt, now };
}
