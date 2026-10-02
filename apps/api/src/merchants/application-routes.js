import { MERCHANT_SLUG_PATTERN, merchantSlug, ROLES } from '#domain';
import { randomUUID } from 'node:crypto';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { hashPassword } from '../auth/password.js';
import { consume } from '../auth/rate-limit.js';
import { revokeUserSessions } from '../auth/session.js';
import { newTemporaryPassword } from '../auth/temporary-password.js';
import { RATE_LIMITS, TEMP_PASSWORD_TTL_MS } from '../config/security.js';
import { newRoleAssignment } from '../db/bootstrap.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { parsePerson } from '../foundation/user-routes.js';
import { HttpError } from '../http/errors.js';
import { clientIp, readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { notify } from '../notify/notify.js';
import { insertMerchant, merchantView, parseMerchantFields } from './merchant-routes.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
const REASON_MAX = 500;
const RECEIVED = { ok: true, status: 'PENDING' };

/** @param {any} error */
const isDuplicateKey = (error) => error?.code === 11000;

const emailHasAccount = () => new HttpError(409, 'EMAIL_HAS_ACCOUNT', 'This email already has an account');
const applicationPending = () => new HttpError(409, 'APPLICATION_PENDING', 'An application with this email or business is already waiting for review');
const notFound = () => new HttpError(404, 'APPLICATION_NOT_FOUND', 'Application not found');

/** @param {import('../http/router.js').Context} ctx */
function sessionOf(ctx) {
  return /** @type {import('../auth/session.js').Session} */ (ctx.session);
}

/** @param {any} application */
function applicationView(application) {
  return {
    id: application._id,
    status: application.status,
    name: application.name,
    slug: application.slug,
    contactEmail: application.contactEmail ?? null,
    contactPhone: application.contactPhone ?? null,
    address: application.address ?? null,
    admin: application.admin,
    createdAt: application.createdAt.toISOString(),
    reviewedAt: application.reviewedAt?.toISOString() ?? null,
    rejectReason: application.rejectReason ?? null,
    tenantId: application.tenantId ?? null,
  };
}

/**
 * First Merchant admin of the application; every field required, errors name `admin.<field>`.
 * @param {unknown} value
 */
function parseApplicant(value) {
  const body = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  try {
    stringField(body, 'preferredLanguage', { max: 2 });
    return parsePerson(body);
  } catch (error) {
    if (error instanceof HttpError && error.details && typeof error.details === 'object') {
      const field = /** @type {{ field?: string }} */ (error.details).field;
      throw new HttpError(error.status, error.code, error.message, { details: { field: `admin.${field}` } });
    }
    throw error;
  }
}

/** Emails of the active Platform admins, for the "new application" notice. */
async function platformAdminEmails() {
  const users = await collection('users');
  const rows = await users
    .find({ status: 'ACTIVE', roles: { $elemMatch: { role: ROLES.PLATFORM_ADMIN, status: 'ACTIVE' } } }, { projection: { email: 1 } })
    .toArray();
  return rows.map((user) => user.email);
}

/**
 * Refuses names, links and emails that are taken; the unique indexes catch a race between two submits.
 * @param {{ name: string, slug: string, email: string }} input
 * @param {import('mongodb').ClientSession} [tx]
 */
async function assertAvailable({ name, slug, email }, tx) {
  const tenants = await collection('tenants');
  if (await tenants.countDocuments({ $or: [{ name }, { slug }] }, { session: tx, limit: 1 })) {
    throw new HttpError(409, 'MERCHANT_EXISTS', 'A merchant with this name or slug already exists');
  }
  const users = await collection('users');
  if (await users.countDocuments({ email }, { session: tx, limit: 1 })) throw emailHasAccount();
}

/**
 * Public. A filled honeypot gets the normal answer but nothing is stored.
 * @type {import('../http/router.js').Handler}
 */
async function submitApplication(req, res, ctx) {
  await consume(`merchant-apply:ip:${clientIp(req)}`, RATE_LIMITS.merchantApplicationIp);
  const body = await readJson(req);
  if (body.website !== undefined && body.website !== '') {
    sendJson(res, 202, RECEIVED);
    return;
  }
  const fields = parseMerchantFields({ ...body, slug: undefined });
  const admin = parseApplicant(body.admin);
  if (body.acceptTerms !== true) {
    throw new HttpError(422, 'TERMS_NOT_ACCEPTED', 'The terms must be accepted', { details: { field: 'acceptTerms' } });
  }
  await consume(`merchant-apply:email:${admin.email}`, RATE_LIMITS.merchantApplicationEmail);

  await assertAvailable({ name: fields.name, slug: fields.slug, email: admin.email });
  const applications = await collection('merchantApplications');
  if (await applications.countDocuments({ status: 'PENDING', $or: [{ 'admin.email': admin.email }, { slug: fields.slug }] }, { limit: 1 })) {
    throw applicationPending();
  }

  const now = new Date();
  const application = {
    _id: randomUUID(),
    status: 'PENDING',
    ...fields,
    admin,
    termsAcceptedAt: now,
    createdAt: now,
    updatedAt: now,
    reviewedBy: null,
    reviewedAt: null,
    rejectReason: null,
    tenantId: null,
    userId: null,
  };
  try {
    await withTransaction(async (tx) => {
      await applications.insertOne(application, { session: tx });
      await recordAudit(
        {
          eventType: 'MERCHANT_APPLICATION_SUBMITTED',
          entityType: 'merchant_application',
          entityId: application._id,
          after: { name: fields.name, slug: fields.slug, adminEmail: admin.email },
          correlationId: ctx.requestId,
        },
        { session: tx },
      );
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw applicationPending();
    throw error;
  }

  await notify('APPLICATION_RECEIVED', { to: [admin.email], language: admin.preferredLanguage, name: fields.name, displayName: admin.displayName });
  await notify('APPLICATION_NEW_FOR_ADMINS', { to: await platformAdminEmails(), name: fields.name, applicationId: application._id });
  sendJson(res, 202, RECEIVED);
}

/** @type {import('../http/router.js').Handler} */
async function listApplications(req, res) {
  const status = new URL(req.url ?? '/', 'http://localhost').searchParams.get('status') || 'PENDING';
  if (!STATUSES.includes(status)) throw new HttpError(422, 'VALIDATION', 'status is invalid', { details: { field: 'status' } });
  const applications = await collection('merchantApplications');
  const rows = await applications
    .find({ status }, { sort: { createdAt: status === 'PENDING' ? 1 : -1 }, limit: 200 })
    .toArray();
  sendJson(res, 200, { applications: rows.map(applicationView) });
}

/**
 * @param {import('../http/router.js').Context} ctx
 * @param {import('mongodb').ClientSession} tx
 */
async function pendingApplication(ctx, tx) {
  const id = ctx.params.id.toLowerCase();
  if (!UUID_PATTERN.test(id)) throw notFound();
  const applications = await collection('merchantApplications');
  const application = await applications.findOne({ _id: id }, { session: tx });
  if (!application) throw notFound();
  if (application.status !== 'PENDING') {
    throw new HttpError(409, 'APPLICATION_NOT_PENDING', 'This application was already reviewed');
  }
  return application;
}

/** @param {import('mongodb').ClientSession} tx @param {string} id @param {Record<string, unknown>} set */
async function closeApplication(tx, id, set) {
  const applications = await collection('merchantApplications');
  const { modifiedCount } = await applications.updateOne(
    { _id: id, status: 'PENDING' },
    { $set: { ...set, updatedAt: new Date() } },
    { session: tx },
  );
  if (modifiedCount !== 1) throw new HttpError(409, 'APPLICATION_NOT_PENDING', 'This application was already reviewed');
}

/**
 * Creates the merchant (as "New merchant" does) and its first Merchant admin, ACTIVE with a temporary
 * password returned only in this response. Optional `name` / `slug` override the application.
 * @type {import('../http/router.js').Handler}
 */
async function approveApplication(req, res, ctx) {
  const session = sessionOf(ctx);
  const body = await readJson(req);
  const nameOverride = stringField(body, 'name', { max: 120, optional: true }).trim();
  const slugOverride = stringField(body, 'slug', { max: 48, optional: true }).trim().toLowerCase();
  if (slugOverride && !MERCHANT_SLUG_PATTERN.test(slugOverride)) {
    throw new HttpError(422, 'VALIDATION', 'slug is invalid', { details: { field: 'slug' } });
  }
  const temporaryPassword = newTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const result = await withTransaction(async (tx) => {
    const application = await pendingApplication(ctx, tx);
    const fields = parseMerchantFields({
      name: nameOverride || application.name,
      slug: slugOverride || (nameOverride ? merchantSlug(nameOverride) : application.slug),
      contactEmail: application.contactEmail,
      contactPhone: application.contactPhone,
      address: application.address,
    });
    const { email, displayName, preferredLanguage } = application.admin;
    const users = await collection('users');
    if (await users.countDocuments({ email }, { session: tx, limit: 1 })) throw emailHasAccount();

    const tenant = await insertMerchant(ctx, fields, tx);
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
          roles: [newRoleAssignment({ role: ROLES.TENANT_ADMIN, tenantId: tenant._id, createdBy: session.userId })],
          createdAt: now,
          updatedAt: now,
        },
        { session: tx },
      );
    } catch (error) {
      if (isDuplicateKey(error)) throw emailHasAccount();
      throw error;
    }
    await closeApplication(tx, application._id, {
      status: 'APPROVED',
      name: fields.name,
      slug: fields.slug,
      reviewedBy: session.userId,
      reviewedAt: now,
      tenantId: tenant._id,
      userId,
    });
    const actor = { ...actorOf(ctx), tenantId: tenant._id };
    await recordAudit(
      {
        ...actor,
        eventType: 'MERCHANT_APPLICATION_APPROVED',
        entityType: 'merchant_application',
        entityId: application._id,
        after: { tenantId: tenant._id, userId, name: fields.name, slug: fields.slug },
      },
      { session: tx },
    );
    await recordAudit(
      { ...actor, eventType: 'TEMPORARY_PASSWORD_ISSUED', entityType: 'user_account', entityId: userId, after: { role: ROLES.TENANT_ADMIN, expiresAt } },
      { session: tx },
    );
    return { tenant, email, displayName, preferredLanguage, expiresAt };
  });

  await notify('APPLICATION_APPROVED', {
    to: [result.email],
    language: result.preferredLanguage,
    name: result.tenant.name,
    displayName: result.displayName,
    temporaryPassword,
    expiresAt: result.expiresAt.toISOString(),
  });
  sendJson(res, 201, {
    merchant: merchantView(result.tenant, new Map()),
    admin: { email: result.email },
    temporaryPassword,
    expiresAt: result.expiresAt.toISOString(),
  });
}

/** @type {import('../http/router.js').Handler} */
async function rejectApplication(req, res, ctx) {
  const session = sessionOf(ctx);
  const reason = stringField(await readJson(req), 'reason', { max: REASON_MAX }).trim();
  if (!reason) throw new HttpError(422, 'VALIDATION', 'reason is required', { details: { field: 'reason' } });

  const application = await withTransaction(async (tx) => {
    const found = await pendingApplication(ctx, tx);
    const now = new Date();
    await closeApplication(tx, found._id, { status: 'REJECTED', reviewedBy: session.userId, reviewedAt: now, rejectReason: reason });
    await recordAudit(
      { ...actorOf(ctx), eventType: 'MERCHANT_APPLICATION_REJECTED', entityType: 'merchant_application', entityId: found._id, reason },
      { session: tx },
    );
    return { ...found, status: 'REJECTED', reviewedBy: session.userId, reviewedAt: now, rejectReason: reason };
  });

  await notify('APPLICATION_REJECTED', { to: [application.admin.email], language: application.admin.preferredLanguage, name: application.name, reason });
  sendJson(res, 200, { application: applicationView(application) });
}

/**
 * New temporary password for an account that has not replaced its temporary one yet; old sessions end.
 * @type {import('../http/router.js').Handler}
 */
async function reissueTemporaryPassword(_req, res, ctx) {
  const userId = ctx.params.userId.toLowerCase();
  if (!UUID_PATTERN.test(userId)) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
  const temporaryPassword = newTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const result = await withTransaction(async (tx) => {
    const users = await collection('users');
    const user = await users.findOne(
      { _id: userId, status: 'ACTIVE' },
      { session: tx, projection: { email: 1, displayName: 1, preferredLanguage: 1, mustChangePassword: 1, roles: 1 } },
    );
    if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
    if (user.mustChangePassword !== true) {
      throw new HttpError(409, 'TEMP_PASSWORD_NOT_NEEDED', 'This account already chose its own password; send a reset link instead');
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TEMP_PASSWORD_TTL_MS);
    await users.updateOne(
      { _id: userId },
      { $set: { passwordHash, passwordChangedAt: now, tempPasswordExpiresAt: expiresAt, updatedAt: now } },
      { session: tx },
    );
    await revokeUserSessions(userId, { session: tx });
    const tenantId = user.roles.find((/** @type {any} */ assignment) => assignment.status === 'ACTIVE' && assignment.tenantId)?.tenantId ?? null;
    await recordAudit(
      { ...actorOf(ctx), tenantId, eventType: 'TEMPORARY_PASSWORD_ISSUED', entityType: 'user_account', entityId: userId, after: { expiresAt } },
      { session: tx },
    );
    return { user, expiresAt };
  });

  await notify('TEMPORARY_PASSWORD_REISSUED', {
    to: [result.user.email],
    language: result.user.preferredLanguage,
    displayName: result.user.displayName,
    temporaryPassword,
    expiresAt: result.expiresAt.toISOString(),
  });
  sendJson(res, 201, { admin: { email: result.user.email }, temporaryPassword, expiresAt: result.expiresAt.toISOString() });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const applicationRoutes = [
  { method: 'POST', path: '/api/v1/merchant-applications', handler: submitApplication },
  { method: 'GET', path: '/api/v1/merchant-applications', handler: authed(listApplications, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/merchant-applications/:id/approve', handler: authed(approveApplication, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/merchant-applications/:id/reject', handler: authed(rejectApplication, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/users/:userId/temporary-password', handler: authed(reissueTemporaryPassword, { permission: 'merchant.manage' }) },
];
