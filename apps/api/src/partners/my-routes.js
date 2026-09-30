import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { fromDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { readJson } from '../http/request.js';
import { brandView } from '../merchants/scope.js';
import { sendJson } from '../http/respond.js';
import { parseContact, ruleAmounts } from './partner-routes.js';
import { MERCHANT_PAYS, partnerStats, payoutView } from './stats.js';

const RECENT_LIMIT = 20;

/**
 * MyConnect home of a Partner admin / Referrer: their QR, event counts and commission owed.
 * Only the partner of the active role; no customer, staff or bill data.
 * @type {import('../http/router.js').Handler}
 */
async function myPartner(_req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const partnerId = session.partnerRelationshipId;
  const partners = await collection('partners');
  const partner = partnerId ? await partners.findOne({ _id: partnerId, tenantId: session.tenantId }) : null;
  if (!partner) throw new HttpError(404, 'PARTNER_NOT_FOUND', 'Partner not found');

  const tenants = await collection('tenants');
  const tenant = await tenants.findOne({ _id: partner.tenantId }, { projection: { name: 1, logoAssetId: 1, brandColor: 1 } });
  const commercialRules = await collection('commercialRules');
  const rule = await commercialRules.findOne({ partnerId: partner._id, status: 'ACTIVE' });
  const referralMedia = await collection('referralMedia');
  const medium = partner.status === 'ENDED' ? null : await referralMedia.findOne({ partnerId: partner._id, status: 'ACTIVE' });
  const stats = (await partnerStats([partner._id], { withCommission: true })).get(partner._id);
  const items = await collection('commissionItems');
  const recent = await items
    .find({ partnerId: partner._id, obligationType: { $in: MERCHANT_PAYS } }, { sort: { redeemedAt: -1 }, limit: RECENT_LIMIT })
    .toArray();
  const payouts = await collection('commissionPayouts');
  const paid = await payouts.find({ partnerId: partner._id }, { sort: { paidAt: -1 }, limit: RECENT_LIMIT }).toArray();
  const commissionRate = rule?.companyCommissionRate ?? rule?.individualCommissionRate ?? null;

  sendJson(res, 200, {
    partner: {
      name: partner.name,
      merchantName: tenant?.name ?? null,
      brand: brandView(tenant),
      partnerType: partner.partnerType,
      relationshipKind: partner.relationshipKind,
      status: partner.status,
      contactName: partner.contactName ?? null,
      contactPhone: partner.contactPhone ?? null,
      contactEmail: partner.contactEmail ?? null,
    },
    rule: rule
      ? {
          ...ruleAmounts(rule),
          customerDiscountRate: fromDecimal128(rule.customerDiscountRate),
          commissionRate: commissionRate ? fromDecimal128(commissionRate) : null,
        }
      : null,
    qr: medium ? { token: medium.publicToken } : null,
    stats,
    recent: recent.map((item) => ({
      redeemedAt: item.redeemedAt.toISOString(),
      baseAmount: fromDecimal128(item.baseAmount),
      amount: fromDecimal128(item.amount),
      status: item.status,
      paidAt: item.paidAt ? item.paidAt.toISOString() : null,
    })),
    payouts: paid.map(payoutView),
  });
}

/**
 * The partner keeps its own contact person up to date; the merchant sees the change.
 * @type {import('../http/router.js').Handler}
 */
async function updateMyContact(req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const contact = parseContact(await readJson(req));
  const partners = await collection('partners');
  const updated = await withTransaction(async (tx) => {
    const partner = session.partnerRelationshipId
      ? await partners.findOne(
          { _id: session.partnerRelationshipId, tenantId: session.tenantId },
          { session: tx, projection: { status: 1, contactName: 1, contactPhone: 1, contactEmail: 1 } },
        )
      : null;
    if (!partner) throw new HttpError(404, 'PARTNER_NOT_FOUND', 'Partner not found');
    if (partner.status === 'ENDED') throw new HttpError(409, 'PARTNER_ENDED', 'This partnership has ended');
    await partners.updateOne({ _id: partner._id }, { $set: { ...contact, updatedAt: new Date() } }, { session: tx });
    await recordAudit(
      {
        ...actorOf(ctx),
        eventType: 'PARTNER_CONTACT_UPDATED',
        entityType: 'partner',
        entityId: partner._id,
        before: { contactName: partner.contactName ?? null, contactPhone: partner.contactPhone ?? null, contactEmail: partner.contactEmail ?? null },
        after: contact,
      },
      { session: tx },
    );
    return contact;
  });
  sendJson(res, 200, { contact: updated });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const myRoutes = [
  { method: 'GET', path: '/api/v1/my/partner', handler: authed(myPartner, { permission: 'commission.view_own' }) },
  { method: 'POST', path: '/api/v1/my/partner/contact', handler: authed(updateMyContact, { permission: 'partner.profile_own' }) },
];
