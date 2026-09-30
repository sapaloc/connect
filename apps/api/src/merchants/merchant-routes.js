import { brandColorFor, MERCHANT_SLUG_PATTERN, merchantSlug, ROLES } from '#domain';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { newTenant } from '../db/bootstrap.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { imageAsset, readBinary } from '../files/files.js';
import { inviteMember, parseInvitee } from '../foundation/user-routes.js';
import { HttpError } from '../http/errors.js';
import { readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { brandView } from './scope.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MERCHANT_STATUSES = ['ACTIVE', 'PAUSED'];

/** @param {import('../http/router.js').Context} ctx */
function sessionOf(ctx) {
  return /** @type {import('../auth/session.js').Session} */ (ctx.session);
}

/** @param {any} error */
function isDuplicateKey(error) {
  return error?.code === 11000;
}

/**
 * @param {any} tenant
 * @param {Map<string, { admins: number, members: number }>} counts
 */
function merchantView(tenant, counts) {
  const count = counts.get(tenant._id) ?? { admins: 0, members: 0 };
  return {
    id: tenant._id,
    name: tenant.name,
    slug: tenant.slug ?? null,
    status: tenant.status,
    contactEmail: tenant.contactEmail ?? null,
    contactPhone: tenant.contactPhone ?? null,
    address: tenant.address ?? null,
    brand: brandView(tenant),
    createdAt: tenant.createdAt.toISOString(),
    admins: count.admins,
    members: count.members,
  };
}

/**
 * Active role holders per merchant: admins, and everyone with any merchant role.
 * @param {string[]} tenantIds
 */
async function memberCounts(tenantIds) {
  const users = await collection('users');
  const rows = await users
    .aggregate([
      { $match: { status: { $in: ['INVITED', 'ACTIVE'] }, 'roles.tenantId': { $in: tenantIds } } },
      { $unwind: '$roles' },
      {
        $match: {
          'roles.status': 'ACTIVE',
          'roles.tenantId': { $in: tenantIds },
          'roles.role': { $in: [ROLES.TENANT_ADMIN, ROLES.MANAGER, ROLES.STAFF] },
        },
      },
      {
        $group: {
          _id: { tenantId: '$roles.tenantId', userId: '$_id' },
          admin: { $max: { $cond: [{ $eq: ['$roles.role', ROLES.TENANT_ADMIN] }, 1, 0] } },
        },
      },
      { $group: { _id: '$_id.tenantId', members: { $sum: 1 }, admins: { $sum: '$admin' } } },
    ])
    .toArray();
  return new Map(rows.map((row) => [row._id, { admins: row.admins, members: row.members }]));
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @param {number} max
 */
function optionalText(body, key, max) {
  return stringField(body, key, { max, optional: true }).trim() || null;
}

/** @type {import('../http/router.js').Handler} */
async function listMerchants(_req, res) {
  const tenants = await collection('tenants');
  const rows = await tenants.find({}, { sort: { name: 1 } }).toArray();
  const counts = await memberCounts(rows.map((tenant) => tenant._id));
  sendJson(res, 200, { merchants: rows.map((tenant) => merchantView(tenant, counts)) });
}

/**
 * Creates a merchant and, when `admin` is given, invites its first Merchant admin in the same transaction.
 * @type {import('../http/router.js').Handler}
 */
async function createMerchant(req, res, ctx) {
  const session = sessionOf(ctx);
  const body = await readJson(req);
  const name = stringField(body, 'name', { max: 120 }).trim();
  if (!name) throw new HttpError(422, 'VALIDATION', 'name is required', { details: { field: 'name' } });
  const slug = stringField(body, 'slug', { max: 48, optional: true }).trim().toLowerCase() || merchantSlug(name);
  if (!MERCHANT_SLUG_PATTERN.test(slug)) throw new HttpError(422, 'VALIDATION', 'slug is invalid', { details: { field: 'slug' } });
  const contactEmail = optionalText(body, 'contactEmail', 254)?.toLowerCase() ?? null;
  if (contactEmail && !EMAIL_PATTERN.test(contactEmail)) {
    throw new HttpError(422, 'VALIDATION', 'contactEmail is invalid', { details: { field: 'contactEmail' } });
  }
  const contactPhone = optionalText(body, 'contactPhone', 32);
  const address = optionalText(body, 'address', 300);

  const adminBody = body.admin && typeof body.admin === 'object' ? /** @type {Record<string, unknown>} */ (body.admin) : null;
  const admin = adminBody ? parseInvitee({ ...adminBody, role: ROLES.TENANT_ADMIN }, session) : null;

  try {
    const result = await withTransaction(async (tx) => {
      const tenant = newTenant({ name, slug, contactEmail, contactPhone, address });
      const tenants = await collection('tenants');
      await tenants.insertOne(tenant, { session: tx });
      await recordAudit(
        { ...actorOf(ctx), tenantId: tenant._id, eventType: 'MERCHANT_CREATED', entityType: 'tenant', entityId: tenant._id, after: { name, slug } },
        { session: tx },
      );
      const invitation = admin ? await inviteMember(req, ctx, { ...admin, tenantId: tenant._id }, tx) : null;
      return { merchant: merchantView(tenant, new Map()), invitation };
    });
    sendJson(res, 201, result);
  } catch (error) {
    if (isDuplicateKey(error)) throw new HttpError(409, 'MERCHANT_EXISTS', 'A merchant with this name or slug already exists');
    throw error;
  }
}

/**
 * Pause or resume. A paused merchant's people lose access at their next request (session.js).
 * @type {import('../http/router.js').Handler}
 */
async function setMerchantStatus(req, res, ctx) {
  const id = ctx.params.id.toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Merchant not found');
  const status = stringField(await readJson(req), 'status', { max: 16 });
  if (!MERCHANT_STATUSES.includes(status)) throw new HttpError(422, 'VALIDATION', 'status is invalid', { details: { field: 'status' } });

  const merchant = await withTransaction(async (tx) => {
    const tenants = await collection('tenants');
    const before = await tenants.findOne({ _id: id, status: { $in: MERCHANT_STATUSES } }, { session: tx });
    if (!before) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Merchant not found');
    if (before.status === status) return before;
    const after = { ...before, status };
    await tenants.updateOne({ _id: id }, { $set: { status } }, { session: tx });
    await recordAudit(
      {
        ...actorOf(ctx),
        tenantId: id,
        eventType: status === 'PAUSED' ? 'MERCHANT_PAUSED' : 'MERCHANT_RESUMED',
        entityType: 'tenant',
        entityId: id,
        before: { status: before.status },
        after: { status },
      },
      { session: tx },
    );
    return after;
  });

  const counts = await memberCounts([id]);
  sendJson(res, 200, { merchant: merchantView(merchant, counts) });
}

/** @type {import('../http/router.js').Handler} */
async function merchantSettings(_req, res, ctx) {
  const tenants = await collection('tenants');
  const tenant = await tenants.findOne({ _id: sessionOf(ctx).tenantId }, { projection: { name: 1, logoAssetId: 1, brandColor: 1 } });
  if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Merchant not found');
  sendJson(res, 200, { name: tenant.name, brand: brandView(tenant) });
}

/**
 * New logo for a merchant: stored as WebP, the previous one REPLACED (kept, no longer served).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('../http/router.js').Context} ctx
 * @param {string} tenantId
 */
async function replaceLogo(req, ctx, tenantId) {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
    throw new HttpError(415, 'IMAGE_TYPE_INVALID', 'Send the image as the request body');
  }
  const asset = await imageAsset(await readBinary(req), 'BRAND_LOGO');
  return withTransaction(async (tx) => {
    const tenants = await collection('tenants');
    const tenant = await tenants.findOne({ _id: tenantId, status: { $in: MERCHANT_STATUSES } }, { session: tx });
    if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Merchant not found');
    const now = new Date();
    const files = await collection('fileAssets');
    await files.updateMany(
      { tenantId, assetType: 'BRAND_LOGO', status: 'ACTIVE' },
      { $set: { status: 'REPLACED', replacedAt: now } },
      { session: tx },
    );
    await files.insertOne({ ...asset, tenantId, createdBy: sessionOf(ctx).userId }, { session: tx });
    await tenants.updateOne({ _id: tenantId }, { $set: { logoAssetId: asset._id } }, { session: tx });
    await recordAudit(
      {
        ...actorOf(ctx),
        tenantId,
        eventType: 'MERCHANT_LOGO_CHANGED',
        entityType: 'tenant',
        entityId: tenantId,
        before: { logoAssetId: tenant.logoAssetId ?? null },
        after: { logoAssetId: asset._id, width: asset.width, height: asset.height, byteSize: asset.byteSize },
      },
      { session: tx },
    );
    return brandView({ ...tenant, logoAssetId: asset._id });
  });
}

/** @type {import('../http/router.js').Handler} */
async function uploadOwnLogo(req, res, ctx) {
  sendJson(res, 200, { brand: await replaceLogo(req, ctx, /** @type {string} */ (sessionOf(ctx).tenantId)) });
}

/**
 * Platform admin replaces a merchant's logo (e.g. during onboarding).
 * @type {import('../http/router.js').Handler}
 */
async function uploadMerchantLogo(req, res, ctx) {
  const id = ctx.params.id.toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Merchant not found');
  sendJson(res, 200, { brand: await replaceLogo(req, ctx, id) });
}

/** @type {import('../http/router.js').Handler} */
async function removeOwnLogo(_req, res, ctx) {
  const tenantId = /** @type {string} */ (sessionOf(ctx).tenantId);
  const brand = await withTransaction(async (tx) => {
    const tenants = await collection('tenants');
    const tenant = await tenants.findOne({ _id: tenantId }, { session: tx });
    if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Merchant not found');
    if (!tenant.logoAssetId) return brandView(tenant);
    const files = await collection('fileAssets');
    await files.updateMany({ tenantId, assetType: 'BRAND_LOGO', status: 'ACTIVE' }, { $set: { status: 'REPLACED', replacedAt: new Date() } }, { session: tx });
    await tenants.updateOne({ _id: tenantId }, { $set: { logoAssetId: null } }, { session: tx });
    await recordAudit(
      { ...actorOf(ctx), eventType: 'MERCHANT_LOGO_CHANGED', entityType: 'tenant', entityId: tenantId, before: { logoAssetId: tenant.logoAssetId }, after: { logoAssetId: null } },
      { session: tx },
    );
    return brandView({ ...tenant, logoAssetId: null });
  });
  sendJson(res, 200, { brand });
}

/**
 * Brand colour of the voucher header; refused when no text colour reaches WCAG AA. Empty clears it.
 * @type {import('../http/router.js').Handler}
 */
async function setBrandColor(req, res, ctx) {
  const tenantId = /** @type {string} */ (sessionOf(ctx).tenantId);
  const body = await readJson(req);
  let color = null;
  if (body.brandColor !== null && body.brandColor !== undefined && body.brandColor !== '') {
    const result = brandColorFor(body.brandColor);
    if ('error' in result) throw new HttpError(422, result.error, 'brandColor is not usable', { details: { field: 'brandColor' } });
    color = result.color;
  }
  const brand = await withTransaction(async (tx) => {
    const tenants = await collection('tenants');
    const tenant = await tenants.findOne({ _id: tenantId }, { session: tx });
    if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Merchant not found');
    if ((tenant.brandColor ?? null) !== color) {
      await tenants.updateOne({ _id: tenantId }, { $set: { brandColor: color } }, { session: tx });
      await recordAudit(
        { ...actorOf(ctx), eventType: 'MERCHANT_BRAND_COLOR_CHANGED', entityType: 'tenant', entityId: tenantId, before: { brandColor: tenant.brandColor ?? null }, after: { brandColor: color } },
        { session: tx },
      );
    }
    return brandView({ ...tenant, brandColor: color });
  });
  sendJson(res, 200, { brand });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const merchantRoutes = [
  { method: 'GET', path: '/api/v1/merchant/settings', handler: authed(merchantSettings, { permission: 'partner.list' }) },
  { method: 'POST', path: '/api/v1/merchant/brand', handler: authed(setBrandColor, { permission: 'merchant.settings' }) },
  { method: 'POST', path: '/api/v1/merchant/logo', handler: authed(uploadOwnLogo, { permission: 'merchant.settings' }) },
  { method: 'POST', path: '/api/v1/merchant/logo/remove', handler: authed(removeOwnLogo, { permission: 'merchant.settings' }) },
  { method: 'POST', path: '/api/v1/merchants/:id/logo', handler: authed(uploadMerchantLogo, { permission: 'merchant.manage' }) },
  { method: 'GET', path: '/api/v1/merchants', handler: authed(listMerchants, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/merchants', handler: authed(createMerchant, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/merchants/:id/status', handler: authed(setMerchantStatus, { permission: 'merchant.manage' }) },
];
