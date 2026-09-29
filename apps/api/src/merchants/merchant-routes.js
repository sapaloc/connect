import { MERCHANT_SLUG_PATTERN, merchantSlug, parseVatPercent, ROLES } from '#domain';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { newTenant } from '../db/bootstrap.js';
import { fromDecimal128, toDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { inviteMember, parseInvitee } from '../foundation/user-routes.js';
import { HttpError } from '../http/errors.js';
import { readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';

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
  const tenant = await tenants.findOne({ _id: sessionOf(ctx).tenantId }, { projection: { name: 1, vatRate: 1 } });
  if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Merchant not found');
  sendJson(res, 200, { name: tenant.name, vatRate: tenant.vatRate ? fromDecimal128(tenant.vatRate) : null });
}

/**
 * VAT rate used to split VAT out of what the customer pays (Net/Net commission base, plan §7).
 * Each referral redemption snapshots the rate in force at that moment.
 * @type {import('../http/router.js').Handler}
 */
async function updateMerchantSettings(req, res, ctx) {
  const tenantId = /** @type {string} */ (sessionOf(ctx).tenantId);
  const body = await readJson(req);
  let vatRate;
  try {
    vatRate = parseVatPercent(body.vatPercent);
  } catch {
    throw new HttpError(422, 'VALIDATION', 'vatPercent is invalid', { details: { field: 'vatPercent' } });
  }
  await withTransaction(async (tx) => {
    const tenants = await collection('tenants');
    const before = await tenants.findOne({ _id: tenantId }, { session: tx, projection: { vatRate: 1 } });
    const previous = before?.vatRate ? fromDecimal128(before.vatRate) : null;
    if (previous === vatRate) return;
    await tenants.updateOne({ _id: tenantId }, { $set: { vatRate: toDecimal128(vatRate) } }, { session: tx });
    await recordAudit(
      { ...actorOf(ctx), eventType: 'MERCHANT_VAT_CHANGED', entityType: 'tenant', entityId: tenantId, before: { vatRate: previous }, after: { vatRate } },
      { session: tx },
    );
  });
  sendJson(res, 200, { vatRate });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const merchantRoutes = [
  { method: 'GET', path: '/api/v1/merchant/settings', handler: authed(merchantSettings, { permission: 'partner.list' }) },
  { method: 'POST', path: '/api/v1/merchant/settings', handler: authed(updateMerchantSettings, { permission: 'merchant.settings' }) },
  { method: 'GET', path: '/api/v1/merchants', handler: authed(listMerchants, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/merchants', handler: authed(createMerchant, { permission: 'merchant.manage' }) },
  { method: 'POST', path: '/api/v1/merchants/:id/status', handler: authed(setMerchantStatus, { permission: 'merchant.manage' }) },
];
