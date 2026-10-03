import { ROLES } from '#domain';
import { randomUUID } from 'node:crypto';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { publicOrigin, readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { brandView, UUID_PATTERN } from '../merchants/scope.js';
import { notify } from '../notify/notify.js';
import { insertPartner, parsePartnerFields, partnerWithRelated } from './partner-routes.js';
import { activeProfile, profileView } from './profile-routes.js';

/** Pending requests one partner may have open at a time. */
export const MAX_PENDING_JOIN_REQUESTS = 10;
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
const MERCHANT_LIST_LIMIT = 200;

/** @param {import('../http/router.js').Context} ctx */
function sessionOf(ctx) {
  return /** @type {import('../auth/session.js').Session} */ (ctx.session);
}

const requestNotFound = () => new HttpError(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
const notPending = () => new HttpError(409, 'JOIN_REQUEST_NOT_PENDING', 'This request was already answered or cancelled');
const alreadyPartner = () => new HttpError(409, 'ALREADY_PARTNER', 'You already work with this merchant');

/** @param {Record<string, unknown>} body @param {string} key @param {number} max */
function optionalText(body, key, max) {
  return stringField(body, key, { max, optional: true }).trim() || null;
}

/** Lower case without Vietnamese marks, so "nha hang" finds "Nhà hàng". @param {string} value */
function searchKey(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim();
}

/**
 * Merchants the account already works with (an ACTIVE partner role there).
 * @param {string} userId
 * @param {import('mongodb').ClientSession} [tx]
 */
async function partnerTenantIds(userId, tx) {
  const users = await collection('users');
  const user = await users.findOne({ _id: userId }, { session: tx, projection: { roles: 1 } });
  return new Set(
    (user?.roles ?? [])
      .filter((/** @type {any} */ assignment) => assignment.status === 'ACTIVE' && assignment.tenantId)
      .map((/** @type {any} */ assignment) => assignment.tenantId),
  );
}

/**
 * Active Merchant admins of one merchant, each in their own language.
 * @param {string} tenantId
 * @returns {Promise<import('../notify/notify.js').Recipient[]>}
 */
async function merchantAdminRecipients(tenantId) {
  const users = await collection('users');
  const rows = await users
    .find({ status: 'ACTIVE', roles: { $elemMatch: { tenantId, role: ROLES.TENANT_ADMIN, status: 'ACTIVE' } } }, { projection: { email: 1, preferredLanguage: 1 } })
    .toArray();
  return rows.map((user) => ({ email: user.email, language: user.preferredLanguage === 'vi' ? 'vi' : 'en' }));
}

/** @param {any} request @param {{ merchantName?: string | null, profile?: any }} [extra] */
function requestView(request, { merchantName, profile } = {}) {
  return {
    id: request._id,
    merchantId: request.tenantId,
    ...(merchantName !== undefined ? { merchantName } : {}),
    ...(profile ? { profile: profileView(profile) } : {}),
    message: request.message ?? null,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    rejectReason: request.rejectReason ?? null,
    partnerId: request.partnerId ?? null,
  };
}

/** Name the emails greet: the contact person of a company, the person themself otherwise. @param {any} profile */
const greetingName = (profile) => profile.contactName || profile.name;

/**
 * Merchants that accept new partners (plus any the partner still has a pending request with), with
 * where the partner stands: already a partner, request pending, or the last answer.
 * @type {import('../http/router.js').Handler}
 */
async function listMerchants(req, res, ctx) {
  const profile = await activeProfile(ctx);
  const q = searchKey(new URL(req.url ?? '/', 'http://localhost').searchParams.get('q')?.slice(0, 80) ?? '');
  const requests = await collection('partnerJoinRequests');
  const own = await requests.find({ userId: profile.userId }, { sort: { createdAt: -1 }, limit: 500 }).toArray();
  /** @type {Map<string, any>} */
  const latest = new Map();
  for (const request of own) if (!latest.has(request.tenantId)) latest.set(request.tenantId, request);
  const pendingIds = own.filter((request) => request.status === 'PENDING').map((request) => request.tenantId);

  const tenants = await collection('tenants');
  const rows = await tenants
    .find(
      { status: 'ACTIVE', $or: [{ acceptsNewPartners: true }, { _id: { $in: pendingIds } }] },
      { sort: { name: 1 }, limit: MERCHANT_LIST_LIMIT, projection: { name: 1, address: 1, logoAssetId: 1, brandColor: 1, acceptsNewPartners: 1 } },
    )
    .toArray();
  const joined = await partnerTenantIds(profile.userId);
  const merchants = rows
    .filter((tenant) => !q || searchKey(tenant.name).includes(q))
    .map((tenant) => {
      const request = latest.get(tenant._id);
      return {
        id: tenant._id,
        name: tenant.name,
        address: tenant.address ?? null,
        brand: brandView(tenant),
        acceptsNewPartners: tenant.acceptsNewPartners === true,
        partner: joined.has(tenant._id),
        request: request ? requestView(request) : null,
      };
    });
  sendJson(res, 200, {
    merchants,
    pendingCount: pendingIds.length,
    maxPending: MAX_PENDING_JOIN_REQUESTS,
  });
}

/**
 * Partner asks a merchant to work together, with an optional message. Refused when the merchant does
 * not accept new partners, the partner already works with it, a request is pending, or too many are.
 * @type {import('../http/router.js').Handler}
 */
async function createRequest(req, res, ctx) {
  const body = await readJson(req);
  const merchantId = stringField(body, 'merchantId', { max: 36 }).toLowerCase();
  if (!UUID_PATTERN.test(merchantId)) throw new HttpError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
  const message = optionalText(body, 'message', 500);

  const result = await withTransaction(async (tx) => {
    const profile = await activeProfile(ctx, tx);
    const tenants = await collection('tenants');
    const tenant = await tenants.findOne({ _id: merchantId, status: 'ACTIVE', acceptsNewPartners: true }, { session: tx, projection: { name: 1 } });
    if (!tenant) throw new HttpError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
    if ((await partnerTenantIds(profile.userId, tx)).has(merchantId)) throw alreadyPartner();
    const requests = await collection('partnerJoinRequests');
    if (await requests.countDocuments({ userId: profile.userId, tenantId: merchantId, status: 'PENDING' }, { session: tx, limit: 1 })) {
      throw new HttpError(409, 'JOIN_REQUEST_PENDING', 'A request to this merchant is already waiting');
    }
    if ((await requests.countDocuments({ userId: profile.userId, status: 'PENDING' }, { session: tx })) >= MAX_PENDING_JOIN_REQUESTS) {
      throw new HttpError(409, 'JOIN_REQUEST_LIMIT', 'Too many requests are waiting', { details: { max: MAX_PENDING_JOIN_REQUESTS } });
    }
    const now = new Date();
    const request = {
      _id: randomUUID(),
      tenantId: merchantId,
      userId: profile.userId,
      profileId: profile._id,
      message,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      rejectReason: null,
      cancelledAt: null,
      partnerId: null,
    };
    try {
      await requests.insertOne(request, { session: tx });
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 11000) throw new HttpError(409, 'JOIN_REQUEST_PENDING', 'A request to this merchant is already waiting');
      throw error;
    }
    await recordAudit(
      {
        ...actorOf(ctx),
        tenantId: merchantId,
        eventType: 'PARTNER_JOIN_REQUESTED',
        entityType: 'partner_join_request',
        entityId: request._id,
        after: { profileId: profile._id, name: profile.name },
      },
      { session: tx },
    );
    return { request, profile, merchantName: tenant.name };
  });

  const { request, profile, merchantName } = result;
  const emailSent = await notify(
    'JOIN_REQUEST_NEW_FOR_MERCHANT',
    {
      to: await merchantAdminRecipients(request.tenantId),
      name: profile.name,
      displayName: greetingName(profile),
      applicantEmail: profile.email,
      partnerType: profile.partnerType,
      relationshipKind: profile.relationshipKind,
      merchantName,
      message: request.message ?? undefined,
      origin: publicOrigin(req),
    },
    { ...actorOf(ctx), tenantId: request.tenantId, entityType: 'partner_join_request', entityId: request._id },
  );
  sendJson(res, 201, { request: requestView(request, { merchantName }), emailSent });
}

/** @type {import('../http/router.js').Handler} */
async function cancelRequest(_req, res, ctx) {
  const id = ctx.params.id.toLowerCase();
  if (!UUID_PATTERN.test(id)) throw requestNotFound();
  const request = await withTransaction(async (tx) => {
    const profile = await activeProfile(ctx, tx);
    const requests = await collection('partnerJoinRequests');
    const found = await requests.findOne({ _id: id, userId: profile.userId }, { session: tx });
    if (!found) throw requestNotFound();
    if (found.status !== 'PENDING') throw notPending();
    const now = new Date();
    await requests.updateOne({ _id: id, status: 'PENDING' }, { $set: { status: 'CANCELLED', cancelledAt: now, updatedAt: now } }, { session: tx });
    await recordAudit(
      { ...actorOf(ctx), tenantId: found.tenantId, eventType: 'PARTNER_JOIN_CANCELLED', entityType: 'partner_join_request', entityId: id },
      { session: tx },
    );
    return { ...found, status: 'CANCELLED', cancelledAt: now, updatedAt: now };
  });
  sendJson(res, 200, { request: requestView(request) });
}

/**
 * Join requests to the signed-in merchant (PENDING by default, oldest first), with the partner profile.
 * @type {import('../http/router.js').Handler}
 */
async function listMerchantRequests(req, res, ctx) {
  const status = new URL(req.url ?? '/', 'http://localhost').searchParams.get('status') || 'PENDING';
  if (!STATUSES.includes(status)) throw new HttpError(422, 'VALIDATION', 'status is invalid', { details: { field: 'status' } });
  const requests = await collection('partnerJoinRequests');
  const rows = await requests
    .find({ tenantId: sessionOf(ctx).tenantId, status }, { sort: { createdAt: status === 'PENDING' ? 1 : -1 }, limit: 200 })
    .toArray();
  const profiles = await collection('partnerProfiles');
  const byId = new Map(
    (await profiles.find({ _id: { $in: rows.map((request) => request.profileId) } }).toArray()).map((profile) => [profile._id, profile]),
  );
  sendJson(res, 200, {
    requests: rows.filter((request) => byId.has(request.profileId)).map((request) => requestView(request, { profile: byId.get(request.profileId) })),
  });
}

/**
 * A PENDING request to the signed-in merchant; another merchant's request is not found.
 * @param {import('../http/router.js').Context} ctx
 * @param {import('mongodb').ClientSession} tx
 */
async function pendingOwnRequest(ctx, tx) {
  const id = ctx.params.id.toLowerCase();
  if (!UUID_PATTERN.test(id)) throw requestNotFound();
  const requests = await collection('partnerJoinRequests');
  const request = await requests.findOne({ _id: id, tenantId: sessionOf(ctx).tenantId }, { session: tx });
  if (!request) throw requestNotFound();
  if (request.status !== 'PENDING') throw notPending();
  return request;
}

/**
 * @param {import('mongodb').ClientSession} tx
 * @param {string} id
 * @param {Record<string, unknown>} set
 */
async function closeRequest(tx, id, set) {
  const requests = await collection('partnerJoinRequests');
  const { modifiedCount } = await requests.updateOne({ _id: id, status: 'PENDING' }, { $set: { ...set, updatedAt: new Date() } }, { session: tx });
  if (modifiedCount !== 1) throw notPending();
}

/**
 * Merchant admin accepts with the add-partner form (prefilled from the profile): creates the partner,
 * its terms and QR, and gives the partner role to the requester's existing account (no new password).
 * @type {import('../http/router.js').Handler}
 */
async function approveRequest(req, res, ctx) {
  const session = sessionOf(ctx);
  const fields = parsePartnerFields(await readJson(req));

  const result = await withTransaction(async (tx) => {
    const request = await pendingOwnRequest(ctx, tx);
    const profiles = await collection('partnerProfiles');
    const profile = await profiles.findOne({ _id: request.profileId, status: 'ACTIVE' }, { session: tx });
    const users = await collection('users');
    const user = await users.findOne({ _id: request.userId, status: 'ACTIVE' }, { session: tx, projection: { email: 1, displayName: 1, preferredLanguage: 1 } });
    if (!profile || !user) throw new HttpError(409, 'PARTNER_PROFILE_INACTIVE', 'This partner account is no longer active');
    if ((await partnerTenantIds(user._id, tx)).has(request.tenantId)) throw alreadyPartner();
    const { partner } = await insertPartner(
      req,
      ctx,
      fields,
      { email: user.email, displayName: user.displayName, preferredLanguage: user.preferredLanguage === 'vi' ? 'vi' : 'en' },
      tx,
    );
    const now = new Date();
    await closeRequest(tx, request._id, { status: 'APPROVED', reviewedBy: session.userId, reviewedAt: now, partnerId: partner._id });
    await recordAudit(
      { ...actorOf(ctx), eventType: 'PARTNER_JOIN_APPROVED', entityType: 'partner_join_request', entityId: request._id, after: { partnerId: partner._id, userId: user._id } },
      { session: tx },
    );
    const tenants = await collection('tenants');
    const tenant = await tenants.findOne({ _id: request.tenantId }, { session: tx, projection: { name: 1 } });
    return {
      request: { ...request, status: 'APPROVED', reviewedBy: session.userId, reviewedAt: now, partnerId: partner._id },
      partner,
      profile,
      user,
      merchantName: tenant?.name ?? '',
    };
  });

  const { request, profile, user, merchantName } = result;
  const emailSent = await notify(
    'JOIN_REQUEST_APPROVED',
    {
      to: [{ email: user.email, language: profile.preferredLanguage }],
      name: result.partner.name,
      displayName: greetingName(profile),
      merchantName,
      origin: publicOrigin(req),
    },
    { ...actorOf(ctx), entityType: 'partner_join_request', entityId: request._id },
  );
  sendJson(res, 201, { request: requestView(request), partner: await partnerWithRelated(result.partner), emailSent });
}

/**
 * Merchant admin declines, with an optional reason told to the partner.
 * @type {import('../http/router.js').Handler}
 */
async function rejectRequest(req, res, ctx) {
  const session = sessionOf(ctx);
  const reason = optionalText(await readJson(req), 'reason', 500);
  const result = await withTransaction(async (tx) => {
    const request = await pendingOwnRequest(ctx, tx);
    const now = new Date();
    await closeRequest(tx, request._id, { status: 'REJECTED', reviewedBy: session.userId, reviewedAt: now, rejectReason: reason });
    await recordAudit(
      { ...actorOf(ctx), eventType: 'PARTNER_JOIN_REJECTED', entityType: 'partner_join_request', entityId: request._id, reason },
      { session: tx },
    );
    const profiles = await collection('partnerProfiles');
    const profile = await profiles.findOne({ _id: request.profileId }, { session: tx });
    const tenants = await collection('tenants');
    const tenant = await tenants.findOne({ _id: request.tenantId }, { session: tx, projection: { name: 1 } });
    return { request: { ...request, status: 'REJECTED', reviewedBy: session.userId, reviewedAt: now, rejectReason: reason }, profile, merchantName: tenant?.name ?? '' };
  });

  const { request, profile, merchantName } = result;
  const emailSent = profile
    ? await notify(
        'JOIN_REQUEST_REJECTED',
        {
          to: [{ email: profile.email, language: profile.preferredLanguage }],
          name: profile.name,
          displayName: greetingName(profile),
          merchantName,
          reason: reason ?? undefined,
          origin: publicOrigin(req),
        },
        { ...actorOf(ctx), entityType: 'partner_join_request', entityId: request._id },
      )
    : false;
  sendJson(res, 200, { request: requestView(request), emailSent });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const joinRoutes = [
  { method: 'GET', path: '/api/v1/partner-merchants', handler: authed(listMerchants, { allowNoRole: true }) },
  { method: 'POST', path: '/api/v1/partner-join-requests', handler: authed(createRequest, { allowNoRole: true }) },
  { method: 'POST', path: '/api/v1/partner-join-requests/:id/cancel', handler: authed(cancelRequest, { allowNoRole: true }) },
  { method: 'GET', path: '/api/v1/merchant/join-requests', handler: authed(listMerchantRequests, { permission: 'partner.join_requests' }) },
  { method: 'POST', path: '/api/v1/merchant/join-requests/:id/approve', handler: authed(approveRequest, { permission: 'partner.manage' }) },
  { method: 'POST', path: '/api/v1/merchant/join-requests/:id/reject', handler: authed(rejectRequest, { permission: 'partner.manage' }) },
];
