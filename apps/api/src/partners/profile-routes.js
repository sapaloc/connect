import { RELATIONSHIP_KINDS, roleSide } from '#domain';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';

const LANGUAGES = ['en', 'vi'];

/** @param {any} profile */
export function profileView(profile) {
  return {
    id: profile._id,
    relationshipKind: profile.relationshipKind,
    partnerType: profile.partnerType,
    name: profile.name,
    contactName: profile.contactName ?? null,
    phone: profile.phone ?? null,
    email: profile.email,
    preferredLanguage: profile.preferredLanguage,
    note: profile.note ?? null,
    status: profile.status,
    createdAt: profile.createdAt.toISOString(),
  };
}

/**
 * Whether the account has an ACTIVE partner profile: lets an account without any role sign in.
 * @param {string} userId
 */
export async function hasActivePartnerProfile(userId) {
  const profiles = await collection('partnerProfiles');
  return (await profiles.countDocuments({ userId, status: 'ACTIVE' }, { limit: 1 })) > 0;
}

/**
 * The profile of the signed-in partner: a session without a role (no merchant yet) or with a partner role.
 * @param {import('../http/router.js').Context} ctx
 * @param {import('mongodb').ClientSession} [tx]
 */
async function ownProfile(ctx, tx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  if (session.role && roleSide(session.role) !== 'PARTNER') throw new HttpError(403, 'FORBIDDEN', 'Not allowed for this role');
  const profiles = await collection('partnerProfiles');
  const profile = await profiles.findOne({ userId: session.userId }, { session: tx });
  if (!profile || (!session.role && profile.status !== 'ACTIVE')) {
    throw new HttpError(404, 'PARTNER_PROFILE_NOT_FOUND', 'Partner profile not found');
  }
  return profile;
}

/**
 * The ACTIVE profile of the signed-in partner, with or without merchants: needed to find merchants.
 * @param {import('../http/router.js').Context} ctx
 * @param {import('mongodb').ClientSession} [tx]
 */
export async function activeProfile(ctx, tx) {
  const profile = await ownProfile(ctx, tx);
  if (profile.status !== 'ACTIVE') throw new HttpError(404, 'PARTNER_PROFILE_NOT_FOUND', 'Partner profile not found');
  return profile;
}

/** @type {import('../http/router.js').Handler} */
async function getProfile(_req, res, ctx) {
  sendJson(res, 200, { profile: profileView(await ownProfile(ctx)) });
}

/**
 * Contact details the partner may change: contact person, phone, language, note. The language is also
 * the account's, so emails follow it.
 * @type {import('../http/router.js').Handler}
 */
async function updateProfile(req, res, ctx) {
  const body = await readJson(req);
  const contactName = stringField(body, 'contactName', { max: 120, optional: true }).trim() || null;
  const phone = stringField(body, 'phone', { max: 32, optional: true }).trim() || null;
  const note = stringField(body, 'note', { max: 500, optional: true }).trim() || null;
  const preferredLanguage = stringField(body, 'preferredLanguage', { max: 2 });
  if (!LANGUAGES.includes(preferredLanguage)) {
    throw new HttpError(422, 'VALIDATION', 'preferredLanguage is invalid', { details: { field: 'preferredLanguage' } });
  }

  const profile = await withTransaction(async (tx) => {
    const before = await ownProfile(ctx, tx);
    if (before.relationshipKind === RELATIONSHIP_KINDS.COMPANY && !contactName) {
      throw new HttpError(422, 'VALIDATION', 'contactName is required', { details: { field: 'contactName' } });
    }
    const now = new Date();
    const set = { contactName, phone, note, preferredLanguage };
    const profiles = await collection('partnerProfiles');
    await profiles.updateOne({ _id: before._id }, { $set: { ...set, updatedAt: now } }, { session: tx });
    const users = await collection('users');
    await users.updateOne({ _id: before.userId }, { $set: { preferredLanguage, updatedAt: now } }, { session: tx });
    await recordAudit(
      {
        ...actorOf(ctx),
        eventType: 'PARTNER_PROFILE_UPDATED',
        entityType: 'partner_profile',
        entityId: before._id,
        before: { contactName: before.contactName ?? null, phone: before.phone ?? null, note: before.note ?? null, preferredLanguage: before.preferredLanguage },
        after: set,
      },
      { session: tx },
    );
    return { ...before, ...set, updatedAt: now };
  });
  sendJson(res, 200, { profile: profileView(profile) });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const partnerProfileRoutes = [
  { method: 'GET', path: '/api/v1/partner-profile', handler: authed(getProfile, { allowNoRole: true }) },
  { method: 'POST', path: '/api/v1/partner-profile', handler: authed(updateProfile, { allowNoRole: true }) },
];
