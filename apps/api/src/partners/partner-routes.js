import { can, commercialRuleFromPercents, PARTNER_STATUSES, PARTNER_TYPES, partnerAccountRole, RELATIONSHIP_KINDS } from '#domain';
import { randomUUID } from 'node:crypto';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { fromDecimal128, toDecimal128 } from '../db/decimal.js';
import { newReferralMedium } from '../db/bootstrap.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { inviteMember, parsePerson } from '../foundation/user-routes.js';
import { HttpError } from '../http/errors.js';
import { readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { merchantBrands, merchantNames, scopeFilter, UUID_PATTERN } from '../merchants/scope.js';
import { partnerStats } from './stats.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_FIELDS = /** @type {const} */ ([
  'totalBudgetRate',
  'customerDiscountRate',
  'companyCommissionRate',
  'individualShareRate',
  'companyNetCommissionRate',
  'individualCommissionRate',
]);

/** @param {import('../http/router.js').Context} ctx */
function sessionOf(ctx) {
  return /** @type {import('../auth/session.js').Session} */ (ctx.session);
}

/** @param {string} name */
function nameKey(name) {
  return name.normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ');
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @param {number} max
 */
function optionalText(body, key, max) {
  return stringField(body, key, { max, optional: true }).trim() || null;
}

/** @param {any} rule stored commercial rule version */
function ruleView(rule) {
  if (!rule) return null;
  /** @type {Record<string, string | null>} */
  const rates = {};
  for (const field of RATE_FIELDS) rates[field] = rule[field] ? fromDecimal128(rule[field]) : null;
  return { id: rule._id, version: rule.version, effectiveFrom: rule.effectiveFrom.toISOString(), ...rates };
}

/**
 * @param {any} partner
 * @param {{ rules: Map<string, any>, accounts: Map<string, any[]>, names: Map<string, string>, media: Map<string, any>, brands: Map<string, any> }} related
 */
function partnerView(partner, { rules, accounts, names, media, brands }) {
  const medium = partner.status === 'ENDED' ? null : media.get(partner._id);
  return {
    id: partner._id,
    merchantId: partner.tenantId,
    merchantName: names.get(partner.tenantId) ?? null,
    brand: brands.get(partner.tenantId) ?? null,
    name: partner.name,
    relationshipKind: partner.relationshipKind,
    partnerType: partner.partnerType,
    status: partner.status,
    contactName: partner.contactName ?? null,
    contactPhone: partner.contactPhone ?? null,
    contactEmail: partner.contactEmail ?? null,
    note: partner.note ?? null,
    createdAt: partner.createdAt.toISOString(),
    endReason: partner.endReason ?? null,
    rule: ruleView(rules.get(partner._id)),
    accounts: accounts.get(partner._id) ?? [],
    qr: medium ? { token: medium.publicToken, createdAt: medium.createdAt.toISOString() } : null,
  };
}

/**
 * Active rules, QR and MyConnect accounts of the given partners.
 * @param {any[]} partners
 */
async function related(partners) {
  const ids = partners.map((partner) => partner._id);
  const commercialRules = await collection('commercialRules');
  const rules = new Map(
    (await commercialRules.find({ partnerId: { $in: ids }, status: 'ACTIVE' }).toArray()).map((rule) => [rule.partnerId, rule]),
  );
  const referralMedia = await collection('referralMedia');
  const media = new Map(
    (await referralMedia.find({ partnerId: { $in: ids }, status: 'ACTIVE' }).toArray()).map((medium) => [medium.partnerId, medium]),
  );
  const users = await collection('users');
  const holders = await users
    .find(
      { status: { $in: ['INVITED', 'ACTIVE'] }, roles: { $elemMatch: { partnerRelationshipId: { $in: ids }, status: 'ACTIVE' } } },
      { projection: { email: 1, displayName: 1, status: 1, roles: 1 }, sort: { displayName: 1 } },
    )
    .toArray();
  /** @type {Map<string, any[]>} */
  const accounts = new Map();
  for (const user of holders) {
    for (const assignment of user.roles) {
      if (assignment.status !== 'ACTIVE' || !ids.includes(assignment.partnerRelationshipId)) continue;
      const list = accounts.get(assignment.partnerRelationshipId) ?? [];
      list.push({ id: user._id, email: user.email, displayName: user.displayName, status: user.status, role: assignment.role });
      accounts.set(assignment.partnerRelationshipId, list);
    }
  }
  const names = await merchantNames(partners.map((partner) => partner.tenantId));
  const brands = await merchantBrands(partners.map((partner) => partner.tenantId));
  return { rules, accounts, names, media, brands };
}

/**
 * Rates typed as percents; the commission split is derived so it always adds up.
 * @param {string} relationshipKind
 * @param {unknown} input
 */
function parseRule(relationshipKind, input) {
  const body = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  const { rule, errors } = commercialRuleFromPercents({
    relationshipKind,
    totalBudgetPercent: body.totalBudgetPercent,
    customerDiscountPercent: body.customerDiscountPercent,
    individualSharePercent: body.individualSharePercent ?? '0',
  });
  if (!rule) throw new HttpError(422, 'COMMERCIAL_RULE_INVALID', 'The commercial rule is invalid', { details: { field: 'rule', reasons: errors } });
  return rule;
}

/**
 * @param {import('#domain').CommercialRule} rule
 * @param {{ tenantId: string, partnerId: string, version: number, createdBy: string, now: Date }} meta
 */
function ruleDocument(rule, { tenantId, partnerId, version, createdBy, now }) {
  /** @type {Record<string, unknown>} */
  const rates = {};
  for (const field of RATE_FIELDS) rates[field] = rule[field] ? toDecimal128(/** @type {string} */ (rule[field])) : null;
  return {
    _id: randomUUID(),
    tenantId,
    partnerId,
    version,
    status: 'ACTIVE',
    relationshipKind: rule.relationshipKind,
    ...rates,
    effectiveFrom: now,
    supersededAt: null,
    createdBy,
    createdAt: now,
  };
}

/** @param {import('#domain').CommercialRule} rule */
function rulePercents(rule) {
  return { totalBudgetRate: rule.totalBudgetRate, customerDiscountRate: rule.customerDiscountRate };
}

/**
 * A partner of the signed-in merchant, in any status.
 * @param {import('../http/router.js').Context} ctx
 * @param {import('mongodb').ClientSession} tx
 */
async function ownPartner(ctx, tx) {
  const id = ctx.params.id.toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new HttpError(404, 'PARTNER_NOT_FOUND', 'Partner not found');
  const partners = await collection('partners');
  const partner = await partners.findOne({ _id: id, tenantId: sessionOf(ctx).tenantId }, { session: tx });
  if (!partner) throw new HttpError(404, 'PARTNER_NOT_FOUND', 'Partner not found');
  return partner;
}

/** @param {any} partner */
function refuseEnded(partner) {
  if (partner.status === 'ENDED') throw new HttpError(409, 'PARTNER_ENDED', 'This partner has ended');
}

/** @type {import('../http/router.js').Handler} */
async function listPartners(req, res, ctx) {
  const session = sessionOf(ctx);
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const status = params.get('status');
  if (status && !PARTNER_STATUSES.includes(status)) throw new HttpError(422, 'VALIDATION', 'status is invalid', { details: { field: 'status' } });
  const partners = await collection('partners');
  const rows = await partners
    .find({ ...scopeFilter(session, params.get('merchantId')), ...(status ? { status } : {}) }, { sort: { name: 1 }, limit: 500 })
    .toArray();
  const extra = await related(rows);
  const withCommission = can(session.role, 'commission.list');
  const stats = await partnerStats(
    rows.map((partner) => partner._id),
    { withCommission },
  );
  sendJson(res, 200, {
    partners: rows.map((partner) => ({ ...partnerView(partner, extra), stats: stats.get(partner._id) })),
    withCommission,
  });
}

/**
 * Creates an ACTIVE partner with its first commercial rule and QR and, when `account` is given, invites
 * its MyConnect account in the same transaction.
 * @type {import('../http/router.js').Handler}
 */
async function createPartner(req, res, ctx) {
  const session = sessionOf(ctx);
  const tenantId = /** @type {string} */ (session.tenantId);
  const body = await readJson(req);
  const name = stringField(body, 'name', { max: 120 }).trim();
  if (!name) throw new HttpError(422, 'VALIDATION', 'name is required', { details: { field: 'name' } });
  const relationshipKind = stringField(body, 'relationshipKind', { max: 32 });
  if (!Object.values(RELATIONSHIP_KINDS).includes(/** @type {any} */ (relationshipKind))) {
    throw new HttpError(422, 'VALIDATION', 'relationshipKind is invalid', { details: { field: 'relationshipKind' } });
  }
  const partnerType = stringField(body, 'partnerType', { max: 32 });
  if (!PARTNER_TYPES.includes(partnerType)) throw new HttpError(422, 'VALIDATION', 'partnerType is invalid', { details: { field: 'partnerType' } });
  const contactEmail = optionalText(body, 'contactEmail', 254)?.toLowerCase() ?? null;
  if (contactEmail && !EMAIL_PATTERN.test(contactEmail)) {
    throw new HttpError(422, 'VALIDATION', 'contactEmail is invalid', { details: { field: 'contactEmail' } });
  }
  const rule = parseRule(relationshipKind, body.rule);
  const accountBody = body.account && typeof body.account === 'object' ? /** @type {Record<string, unknown>} */ (body.account) : null;
  const account = accountBody ? parsePerson(accountBody) : null;

  const tenants = await collection('tenants');
  const tenant = await tenants.findOne({ _id: tenantId }, { projection: { vatRate: 1 } });
  if (!tenant?.vatRate) throw new HttpError(409, 'VAT_NOT_SET', 'Set the merchant VAT rate before adding partners');

  const now = new Date();
  const partner = {
    _id: randomUUID(),
    tenantId,
    name,
    nameKey: nameKey(name),
    relationshipKind,
    partnerType,
    status: 'ACTIVE',
    contactName: optionalText(body, 'contactName', 120),
    contactPhone: optionalText(body, 'contactPhone', 32),
    contactEmail,
    note: optionalText(body, 'note', 500),
    createdBy: session.userId,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    endedBy: null,
    endReason: null,
  };
  try {
    const result = await withTransaction(async (tx) => {
      const partners = await collection('partners');
      await partners.insertOne(partner, { session: tx });
      const commercialRules = await collection('commercialRules');
      const ruleDoc = ruleDocument(rule, { tenantId, partnerId: partner._id, version: 1, createdBy: session.userId, now });
      await commercialRules.insertOne(ruleDoc, { session: tx });
      const referralMedia = await collection('referralMedia');
      await referralMedia.insertOne(newReferralMedium(partner, session.userId), { session: tx });
      await recordAudit(
        {
          ...actorOf(ctx),
          eventType: 'PARTNER_CREATED',
          entityType: 'partner_relationship',
          entityId: partner._id,
          after: { name, relationshipKind, partnerType, rule: rulePercents(rule) },
        },
        { session: tx },
      );
      const invitation = account
        ? await inviteMember(
            req,
            ctx,
            { ...account, role: partnerAccountRole(relationshipKind), tenantId, partnerRelationshipId: partner._id },
            tx,
          )
        : null;
      return { ruleDoc, invitation };
    });
    const extra = await related([partner]);
    sendJson(res, 201, { partner: partnerView(partner, extra), invitation: result.invitation });
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 11000) throw new HttpError(409, 'PARTNER_EXISTS', 'A partner with this name already exists');
    throw error;
  }
}

/**
 * New rule version; the previous one is superseded. Vouchers already activated keep their snapshot.
 * @type {import('../http/router.js').Handler}
 */
async function changeRule(req, res, ctx) {
  const session = sessionOf(ctx);
  const body = await readJson(req);
  const partner = await withTransaction(async (tx) => {
    const found = await ownPartner(ctx, tx);
    refuseEnded(found);
    const rule = parseRule(found.relationshipKind, body);
    const commercialRules = await collection('commercialRules');
    const current = await commercialRules.findOne({ partnerId: found._id, status: 'ACTIVE' }, { session: tx });
    const unchanged = current && RATE_FIELDS.every((field) => (current[field] ? fromDecimal128(current[field]) : null) === (rule[field] ?? null));
    if (unchanged) return found;
    const now = new Date();
    if (current) {
      await commercialRules.updateOne({ _id: current._id, status: 'ACTIVE' }, { $set: { status: 'SUPERSEDED', supersededAt: now } }, { session: tx });
    }
    const version = (current?.version ?? 0) + 1;
    await commercialRules.insertOne(ruleDocument(rule, { tenantId: found.tenantId, partnerId: found._id, version, createdBy: session.userId, now }), {
      session: tx,
    });
    await recordAudit(
      {
        ...actorOf(ctx),
        eventType: 'COMMERCIAL_RULE_CHANGED',
        entityType: 'partner_relationship',
        entityId: found._id,
        before: current ? { version: current.version, totalBudgetRate: fromDecimal128(current.totalBudgetRate), customerDiscountRate: fromDecimal128(current.customerDiscountRate) } : null,
        after: { version, ...rulePercents(rule) },
      },
      { session: tx },
    );
    return found;
  });
  sendJson(res, 200, { partner: partnerView(partner, await related([partner])) });
}

/**
 * Pause / resume, or end for good (reason required). Ending also ends the partner's MyConnect roles.
 * @type {import('../http/router.js').Handler}
 */
async function setPartnerStatus(req, res, ctx) {
  const session = sessionOf(ctx);
  const body = await readJson(req);
  const status = stringField(body, 'status', { max: 16 });
  if (!PARTNER_STATUSES.includes(status)) throw new HttpError(422, 'VALIDATION', 'status is invalid', { details: { field: 'status' } });
  const reason = optionalText(body, 'reason', 300);
  if (status === 'ENDED' && !reason) throw new HttpError(422, 'VALIDATION', 'reason is required', { details: { field: 'reason' } });

  const partner = await withTransaction(async (tx) => {
    const found = await ownPartner(ctx, tx);
    refuseEnded(found);
    if (found.status === status) return found;
    const now = new Date();
    const change =
      status === 'ENDED' ? { status, updatedAt: now, endedAt: now, endedBy: session.userId, endReason: reason } : { status, updatedAt: now };
    const partners = await collection('partners');
    await partners.updateOne({ _id: found._id, status: found.status }, { $set: change }, { session: tx });
    if (status === 'ENDED') {
      const users = await collection('users');
      await users.updateMany(
        { roles: { $elemMatch: { partnerRelationshipId: found._id, status: 'ACTIVE' } } },
        { $set: { 'roles.$[role].status': 'ENDED', 'roles.$[role].validUntil': now, updatedAt: now } },
        { session: tx, arrayFilters: [{ 'role.partnerRelationshipId': found._id, 'role.status': 'ACTIVE' }] },
      );
    }
    await recordAudit(
      {
        ...actorOf(ctx),
        eventType: `PARTNER_${status === 'ACTIVE' ? 'RESUMED' : status}`,
        entityType: 'partner_relationship',
        entityId: found._id,
        before: { status: found.status },
        after: { status },
        reason,
      },
      { session: tx },
    );
    return { ...found, ...change };
  });
  sendJson(res, 200, { partner: partnerView(partner, await related([partner])) });
}

/**
 * Invites (or re-invites) the partner's MyConnect account: Partner admin for a company, Referrer for an
 * independent individual.
 * @type {import('../http/router.js').Handler}
 */
async function invitePartnerAccount(req, res, ctx) {
  const person = parsePerson(await readJson(req));
  const result = await withTransaction(async (tx) => {
    const partner = await ownPartner(ctx, tx);
    refuseEnded(partner);
    return inviteMember(
      req,
      ctx,
      { ...person, role: partnerAccountRole(partner.relationshipKind), tenantId: partner.tenantId, partnerRelationshipId: partner._id },
      tx,
    );
  });
  sendJson(res, 201, result);
}

/**
 * New QR for a lost or leaked one: the old link stops at once. Vouchers already activated stay valid.
 * @type {import('../http/router.js').Handler}
 */
async function replaceQr(req, res, ctx) {
  const session = sessionOf(ctx);
  const reason = optionalText(await readJson(req), 'reason', 300);
  const partner = await withTransaction(async (tx) => {
    const found = await ownPartner(ctx, tx);
    refuseEnded(found);
    const referralMedia = await collection('referralMedia');
    const current = await referralMedia.findOne({ partnerId: found._id, status: 'ACTIVE' }, { session: tx });
    const now = new Date();
    if (current) {
      await referralMedia.updateOne(
        { _id: current._id, status: 'ACTIVE' },
        { $set: { status: 'REPLACED', replacedAt: now, replacedBy: session.userId, replaceReason: reason } },
        { session: tx },
      );
    }
    const medium = newReferralMedium(found, session.userId, current?._id ?? null);
    await referralMedia.insertOne(medium, { session: tx });
    await recordAudit(
      { ...actorOf(ctx), eventType: 'REFERRAL_QR_REPLACED', entityType: 'referral_medium', entityId: medium._id, before: current ? { id: current._id } : null, after: { id: medium._id }, reason },
      { session: tx },
    );
    return found;
  });
  sendJson(res, 200, { partner: partnerView(partner, await related([partner])) });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const partnerRoutes = [
  { method: 'GET', path: '/api/v1/partners', handler: authed(listPartners, { permission: 'partner.list' }) },
  { method: 'POST', path: '/api/v1/partners', handler: authed(createPartner, { permission: 'partner.manage' }) },
  { method: 'POST', path: '/api/v1/partners/:id/rule', handler: authed(changeRule, { permission: 'commercial_rule.manage' }) },
  { method: 'POST', path: '/api/v1/partners/:id/status', handler: authed(setPartnerStatus, { permission: 'partner.manage' }) },
  { method: 'POST', path: '/api/v1/partners/:id/qr/replace', handler: authed(replaceQr, { permission: 'partner.manage' }) },
  { method: 'POST', path: '/api/v1/partners/:id/invitations', handler: authed(invitePartnerAccount, { permission: 'partner.manage' }) },
];
