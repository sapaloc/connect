import { PARTNER_TYPES, RELATIONSHIP_KINDS } from '#domain';
import { randomUUID } from 'node:crypto';
import {
  applicationPending,
  assertEmailFree,
  assertTermsAccepted,
  closeApplication,
  EMAIL_PATTERN,
  insertTemporaryAccount,
  isDuplicateKey,
  isHoneypotFilled,
  LANGUAGES,
  limitApplicationsByEmail,
  limitApplicationsByIp,
  listStatus,
  parseReason,
  pendingApplication,
  platformAdminRecipients,
  RECEIVED,
  temporaryCredentials,
} from '../applications/shared.js';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { publicOrigin, readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { notify } from '../notify/notify.js';
import { profileView } from './profile-routes.js';

const KINDS = Object.values(RELATIONSHIP_KINDS);

/** @param {string} field */
const invalid = (field) => new HttpError(422, 'VALIDATION', `${field} is invalid`, { details: { field } });

/** @param {Record<string, unknown>} body @param {string} key @param {number} max */
function optionalText(body, key, max) {
  return stringField(body, key, { max, optional: true }).trim() || null;
}

/**
 * Who the partner is and how to reach them. A company names its contact person.
 * @param {Record<string, unknown>} body
 */
function parsePartnerApplicant(body) {
  const relationshipKind = body.relationshipKind;
  if (typeof relationshipKind !== 'string' || !KINDS.includes(relationshipKind)) throw invalid('relationshipKind');
  const partnerType = body.partnerType;
  if (typeof partnerType !== 'string' || !PARTNER_TYPES.includes(partnerType)) throw invalid('partnerType');
  const name = stringField(body, 'name', { max: 120 }).trim();
  if (!name) throw new HttpError(422, 'VALIDATION', 'name is required', { details: { field: 'name' } });
  const contactName = optionalText(body, 'contactName', 120);
  if (relationshipKind === RELATIONSHIP_KINDS.COMPANY && !contactName) {
    throw new HttpError(422, 'VALIDATION', 'contactName is required', { details: { field: 'contactName' } });
  }
  const email = stringField(body, 'email', { max: 254 }).trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw invalid('email');
  const preferredLanguage = stringField(body, 'preferredLanguage', { max: 2 });
  if (!LANGUAGES.includes(preferredLanguage)) throw invalid('preferredLanguage');
  return {
    relationshipKind,
    partnerType,
    name,
    contactName,
    phone: optionalText(body, 'phone', 32),
    email,
    preferredLanguage: /** @type {'en' | 'vi'} */ (preferredLanguage),
    note: optionalText(body, 'note', 500),
  };
}

/** @param {any} application */
function applicationView(application) {
  return {
    id: application._id,
    status: application.status,
    relationshipKind: application.relationshipKind,
    partnerType: application.partnerType,
    name: application.name,
    contactName: application.contactName ?? null,
    phone: application.phone ?? null,
    email: application.email,
    preferredLanguage: application.preferredLanguage,
    note: application.note ?? null,
    createdAt: application.createdAt.toISOString(),
    reviewedAt: application.reviewedAt?.toISOString() ?? null,
    rejectReason: application.rejectReason ?? null,
    userId: application.userId ?? null,
  };
}

/** Name the emails greet: the contact person of a company, the person themself otherwise. @param {any} applicant */
const greetingName = (applicant) => applicant.contactName || applicant.name;

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
  const applicant = parsePartnerApplicant(body);
  assertTermsAccepted(body);
  await limitApplicationsByEmail(applicant.email);
  await assertEmailFree(applicant.email);

  const now = new Date();
  const application = {
    _id: randomUUID(),
    status: 'PENDING',
    ...applicant,
    termsAcceptedAt: now,
    createdAt: now,
    updatedAt: now,
    reviewedBy: null,
    reviewedAt: null,
    rejectReason: null,
    userId: null,
    profileId: null,
  };
  try {
    await withTransaction(async (tx) => {
      const applications = await collection('partnerApplications');
      await applications.insertOne(application, { session: tx });
      await recordAudit(
        {
          eventType: 'PARTNER_APPLICATION_SUBMITTED',
          entityType: 'partner_application',
          entityId: application._id,
          after: { name: applicant.name, relationshipKind: applicant.relationshipKind, partnerType: applicant.partnerType, email: applicant.email },
          correlationId: ctx.requestId,
        },
        { session: tx },
      );
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw applicationPending();
    throw error;
  }

  const context = { correlationId: ctx.requestId, entityType: 'partner_application', entityId: application._id };
  const shared = { name: applicant.name, displayName: greetingName(applicant), partnerType: applicant.partnerType, relationshipKind: applicant.relationshipKind, origin: publicOrigin(req) };
  await Promise.all([
    notify('PARTNER_APPLICATION_RECEIVED', { to: [{ email: applicant.email, language: applicant.preferredLanguage }], ...shared }, context),
    notify('PARTNER_APPLICATION_NEW_FOR_ADMINS', { to: await platformAdminRecipients(), ...shared, applicantEmail: applicant.email }, context),
  ]);
  sendJson(res, 202, RECEIVED);
}

/** @type {import('../http/router.js').Handler} */
async function listApplications(req, res) {
  const status = listStatus(req);
  const applications = await collection('partnerApplications');
  const rows = await applications
    .find({ status }, { sort: { createdAt: status === 'PENDING' ? 1 : -1 }, limit: 200 })
    .toArray();
  sendJson(res, 200, { applications: rows.map(applicationView) });
}

/**
 * Creates the partner's account (ACTIVE, no role yet, temporary password returned only in this
 * response) and its partner profile. Joining merchants comes later.
 * @type {import('../http/router.js').Handler}
 */
async function approveApplication(req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const { temporaryPassword, passwordHash } = await temporaryCredentials();

  const result = await withTransaction(async (tx) => {
    const application = await pendingApplication('partnerApplications', ctx.params.id, tx);
    const { userId, expiresAt, now } = await insertTemporaryAccount(
      { email: application.email, displayName: greetingName(application), preferredLanguage: application.preferredLanguage, passwordHash, roles: [] },
      tx,
    );
    const profile = {
      _id: randomUUID(),
      userId,
      relationshipKind: application.relationshipKind,
      partnerType: application.partnerType,
      name: application.name,
      contactName: application.contactName ?? null,
      phone: application.phone ?? null,
      email: application.email,
      preferredLanguage: application.preferredLanguage,
      note: application.note ?? null,
      status: 'ACTIVE',
      applicationId: application._id,
      approvedBy: session.userId,
      createdAt: now,
      updatedAt: now,
    };
    const profiles = await collection('partnerProfiles');
    await profiles.insertOne(profile, { session: tx });
    await closeApplication('partnerApplications', tx, application._id, {
      status: 'APPROVED',
      reviewedBy: session.userId,
      reviewedAt: now,
      userId,
      profileId: profile._id,
    });
    await recordAudit(
      {
        ...actorOf(ctx),
        eventType: 'PARTNER_APPLICATION_APPROVED',
        entityType: 'partner_application',
        entityId: application._id,
        after: { userId, profileId: profile._id, name: profile.name },
      },
      { session: tx },
    );
    await recordAudit(
      { ...actorOf(ctx), eventType: 'TEMPORARY_PASSWORD_ISSUED', entityType: 'user_account', entityId: userId, after: { partnerProfileId: profile._id, expiresAt } },
      { session: tx },
    );
    return { profile, expiresAt, userId, displayName: greetingName(application) };
  });

  const { profile } = result;
  const emailSent = await notify(
    'PARTNER_APPLICATION_APPROVED',
    {
      to: [{ email: profile.email, language: profile.preferredLanguage }],
      name: profile.name,
      displayName: result.displayName,
      email: profile.email,
      temporaryPassword,
      expiresAt: result.expiresAt.toISOString(),
      origin: publicOrigin(req),
    },
    { ...actorOf(ctx), entityType: 'user_account', entityId: result.userId },
  );
  sendJson(res, 201, {
    profile: profileView(profile),
    user: { email: profile.email },
    temporaryPassword,
    expiresAt: result.expiresAt.toISOString(),
    emailSent,
  });
}

/** @type {import('../http/router.js').Handler} */
async function rejectApplication(req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const reason = parseReason(await readJson(req));

  const application = await withTransaction(async (tx) => {
    const found = await pendingApplication('partnerApplications', ctx.params.id, tx);
    const now = new Date();
    await closeApplication('partnerApplications', tx, found._id, { status: 'REJECTED', reviewedBy: session.userId, reviewedAt: now, rejectReason: reason });
    await recordAudit(
      { ...actorOf(ctx), eventType: 'PARTNER_APPLICATION_REJECTED', entityType: 'partner_application', entityId: found._id, reason },
      { session: tx },
    );
    return { ...found, status: 'REJECTED', reviewedBy: session.userId, reviewedAt: now, rejectReason: reason };
  });

  const emailSent = await notify(
    'PARTNER_APPLICATION_REJECTED',
    {
      to: [{ email: application.email, language: application.preferredLanguage }],
      name: application.name,
      displayName: greetingName(application),
      reason,
      origin: publicOrigin(req),
    },
    { ...actorOf(ctx), entityType: 'partner_application', entityId: application._id },
  );
  sendJson(res, 200, { application: applicationView(application), emailSent });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const partnerApplicationRoutes = [
  { method: 'POST', path: '/api/v1/partner-applications', handler: submitApplication },
  { method: 'GET', path: '/api/v1/partner-applications', handler: authed(listApplications, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/partner-applications/:id/approve', handler: authed(approveApplication, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/partner-applications/:id/reject', handler: authed(rejectApplication, { permission: 'merchant.manage' }) },
];
