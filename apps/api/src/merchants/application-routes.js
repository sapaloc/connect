import { MERCHANT_SLUG_PATTERN, merchantSlug, ROLES } from '#domain';
import { randomUUID } from 'node:crypto';
import {
  applicationPending,
  assertEmailFree,
  assertTermsAccepted,
  closeApplication,
  insertTemporaryAccount,
  isDuplicateKey,
  isHoneypotFilled,
  limitApplicationsByEmail,
  limitApplicationsByIp,
  listStatus,
  parseReason,
  pendingApplication,
  platformAdminRecipients,
  RECEIVED,
  temporaryCredentials,
  UUID_PATTERN,
} from '../applications/shared.js';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { revokeUserSessions } from '../auth/session.js';
import { TEMP_PASSWORD_TTL_MS } from '../config/security.js';
import { newRoleAssignment } from '../db/bootstrap.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { parsePerson } from '../foundation/user-routes.js';
import { HttpError } from '../http/errors.js';
import { publicOrigin, readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { notify } from '../notify/notify.js';
import { insertMerchant, merchantView, parseMerchantFields } from './merchant-routes.js';

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

/**
 * Refuses names and links that are taken, then emails with an account or a pending application.
 * @param {{ name: string, slug: string, email: string }} input
 */
async function assertAvailable({ name, slug, email }) {
  const tenants = await collection('tenants');
  if (await tenants.countDocuments({ $or: [{ name }, { slug }] }, { limit: 1 })) {
    throw new HttpError(409, 'MERCHANT_EXISTS', 'A merchant with this name or slug already exists');
  }
  await assertEmailFree(email);
  const applications = await collection('merchantApplications');
  if (await applications.countDocuments({ status: 'PENDING', slug }, { limit: 1 })) throw applicationPending();
}

/**
 * Public. A filled honeypot gets the normal answer but nothing is stored.
 * @type {import('../http/router.js').Handler}
 */
async function submitApplication(req, res, ctx) {
  await limitApplicationsByIp(req);
  const body = await readJson(req);
  if (isHoneypotFilled(body)) {
    sendJson(res, 202, RECEIVED);
    return;
  }
  const fields = parseMerchantFields({ ...body, slug: undefined });
  const admin = parseApplicant(body.admin);
  assertTermsAccepted(body);
  await limitApplicationsByEmail(admin.email);
  await assertAvailable({ name: fields.name, slug: fields.slug, email: admin.email });

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
      const applications = await collection('merchantApplications');
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

  const context = { correlationId: ctx.requestId, entityType: 'merchant_application', entityId: application._id };
  const origin = publicOrigin(req);
  await Promise.all([
    notify(
      'APPLICATION_RECEIVED',
      { to: [{ email: admin.email, language: admin.preferredLanguage }], name: fields.name, displayName: admin.displayName, origin },
      context,
    ),
    notify(
      'APPLICATION_NEW_FOR_ADMINS',
      { to: await platformAdminRecipients(), name: fields.name, displayName: admin.displayName, applicantEmail: admin.email, origin },
      context,
    ),
  ]);
  sendJson(res, 202, RECEIVED);
}

/** @type {import('../http/router.js').Handler} */
async function listApplications(req, res) {
  const status = listStatus(req);
  const applications = await collection('merchantApplications');
  const rows = await applications
    .find({ status }, { sort: { createdAt: status === 'PENDING' ? 1 : -1 }, limit: 200 })
    .toArray();
  sendJson(res, 200, { applications: rows.map(applicationView) });
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
  const { temporaryPassword, passwordHash } = await temporaryCredentials();

  const result = await withTransaction(async (tx) => {
    const application = await pendingApplication('merchantApplications', ctx.params.id, tx);
    const fields = parseMerchantFields({
      name: nameOverride || application.name,
      slug: slugOverride || (nameOverride ? merchantSlug(nameOverride) : application.slug),
      contactEmail: application.contactEmail,
      contactPhone: application.contactPhone,
      address: application.address,
    });
    const { email, displayName, preferredLanguage } = application.admin;
    const tenant = await insertMerchant(ctx, fields, tx);
    const { userId, expiresAt, now } = await insertTemporaryAccount(
      {
        email,
        displayName,
        preferredLanguage,
        passwordHash,
        roles: [newRoleAssignment({ role: ROLES.TENANT_ADMIN, tenantId: tenant._id, createdBy: session.userId })],
      },
      tx,
    );
    await closeApplication('merchantApplications', tx, application._id, {
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
    return { tenant, email, displayName, preferredLanguage, expiresAt, userId };
  });

  const emailSent = await notify(
    'APPLICATION_APPROVED',
    {
      to: [{ email: result.email, language: result.preferredLanguage }],
      name: result.tenant.name,
      displayName: result.displayName,
      email: result.email,
      temporaryPassword,
      expiresAt: result.expiresAt.toISOString(),
      origin: publicOrigin(req),
    },
    { ...actorOf(ctx), tenantId: result.tenant._id, entityType: 'user_account', entityId: result.userId },
  );
  sendJson(res, 201, {
    merchant: merchantView(result.tenant, new Map()),
    admin: { email: result.email },
    temporaryPassword,
    expiresAt: result.expiresAt.toISOString(),
    emailSent,
  });
}

/** @type {import('../http/router.js').Handler} */
async function rejectApplication(req, res, ctx) {
  const session = sessionOf(ctx);
  const reason = parseReason(await readJson(req));

  const application = await withTransaction(async (tx) => {
    const found = await pendingApplication('merchantApplications', ctx.params.id, tx);
    const now = new Date();
    await closeApplication('merchantApplications', tx, found._id, { status: 'REJECTED', reviewedBy: session.userId, reviewedAt: now, rejectReason: reason });
    await recordAudit(
      { ...actorOf(ctx), eventType: 'MERCHANT_APPLICATION_REJECTED', entityType: 'merchant_application', entityId: found._id, reason },
      { session: tx },
    );
    return { ...found, status: 'REJECTED', reviewedBy: session.userId, reviewedAt: now, rejectReason: reason };
  });

  const emailSent = await notify(
    'APPLICATION_REJECTED',
    {
      to: [{ email: application.admin.email, language: application.admin.preferredLanguage }],
      name: application.name,
      displayName: application.admin.displayName,
      reason,
      origin: publicOrigin(req),
    },
    { ...actorOf(ctx), entityType: 'merchant_application', entityId: application._id },
  );
  sendJson(res, 200, { application: applicationView(application), emailSent });
}

/**
 * New temporary password for an account that has not replaced its temporary one yet (merchant admin
 * or partner); old sessions end.
 * @type {import('../http/router.js').Handler}
 */
async function reissueTemporaryPassword(req, res, ctx) {
  const userId = ctx.params.userId.toLowerCase();
  if (!UUID_PATTERN.test(userId)) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
  const { temporaryPassword, passwordHash } = await temporaryCredentials();

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
    return { user, expiresAt, tenantId };
  });

  const emailSent = await notify(
    'TEMPORARY_PASSWORD_REISSUED',
    {
      to: [{ email: result.user.email, language: result.user.preferredLanguage }],
      displayName: result.user.displayName,
      email: result.user.email,
      temporaryPassword,
      expiresAt: result.expiresAt.toISOString(),
      origin: publicOrigin(req),
    },
    { ...actorOf(ctx), tenantId: result.tenantId, entityType: 'user_account', entityId: userId },
  );
  sendJson(res, 201, { admin: { email: result.user.email }, temporaryPassword, expiresAt: result.expiresAt.toISOString(), emailSent });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const applicationRoutes = [
  { method: 'POST', path: '/api/v1/merchant-applications', handler: submitApplication },
  { method: 'GET', path: '/api/v1/merchant-applications', handler: authed(listApplications, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/merchant-applications/:id/approve', handler: authed(approveApplication, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/merchant-applications/:id/reject', handler: authed(rejectApplication, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/users/:userId/temporary-password', handler: authed(reissueTemporaryPassword, { permission: 'merchant.manage' }) },
];
