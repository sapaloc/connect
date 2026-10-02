import { isFixedRule, merchantSlug, partnerMediumType, ROLES } from '#domain';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import { toDecimal128 } from './decimal.js';
import { collection } from './mongo.js';

/** @typedef {{ session?: import('mongodb').ClientSession }} TxOptions */

export const RATE_FIELDS = /** @type {const} */ ([
  'totalBudgetRate',
  'customerDiscountRate',
  'companyCommissionRate',
  'individualShareRate',
  'companyNetCommissionRate',
  'individualCommissionRate',
]);

/**
 * @typedef {{ role: string, tenantId: string | null, partnerRelationshipId?: string | null, createdBy?: string | null }} RoleInput
 */

/**
 * A role assignment embedded in `users.roles`. Partner roles are scoped to one partner relationship.
 * @param {RoleInput} input
 */
export function newRoleAssignment({ role, tenantId, partnerRelationshipId = null, createdBy = null }) {
  const now = new Date();
  return {
    _id: randomUUID(),
    role,
    scopeType: role === ROLES.PLATFORM_ADMIN ? 'PLATFORM' : partnerRelationshipId ? 'PARTNER_RELATIONSHIP' : 'TENANT',
    tenantId,
    partnerRelationshipId,
    affiliatedReferrerId: null,
    status: 'ACTIVE',
    validFrom: now,
    validUntil: null,
    createdAt: now,
    createdBy,
  };
}

/**
 * The partner's own profile (one per account, across merchants), filled from one of its merchant partner
 * records. Merchants keep their own name and contact on `partners`; the partner edits the profile.
 * @param {{ userId: string, email: string, preferredLanguage?: string | null, partner: any, createdBy?: string | null }} input
 */
export function newPartnerProfile({ userId, email, preferredLanguage, partner, createdBy = null }) {
  const now = new Date();
  return {
    _id: randomUUID(),
    userId,
    relationshipKind: partner.relationshipKind,
    partnerType: partner.partnerType,
    name: partner.name,
    contactName: partner.contactName ?? null,
    phone: partner.contactPhone ?? null,
    email,
    preferredLanguage: preferredLanguage === 'vi' ? 'vi' : 'en',
    note: null,
    status: 'ACTIVE',
    applicationId: null,
    approvedBy: createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Adds the role unless the user already holds it, active, in the same tenant (and partner).
 * @param {string} userId
 * @param {RoleInput} input
 * @param {TxOptions} [options]
 */
export async function grantRole(userId, input, options = {}) {
  const users = await collection('users');
  const same = { role: input.role, tenantId: input.tenantId, partnerRelationshipId: input.partnerRelationshipId ?? null, status: 'ACTIVE' };
  await users.updateOne(
    { _id: userId, roles: { $not: { $elemMatch: same } } },
    { $push: { roles: newRoleAssignment(input) }, $set: { updatedAt: new Date() } },
    options,
  );
}

/**
 * Finds a tenant by name, creating it with its operating organization if missing.
 * @param {string} name
 * @param {TxOptions} [options]
 */
export async function ensureTenant(name, options = {}) {
  const tenants = await collection('tenants');
  const found = await tenants.findOne({ name }, { ...options, projection: { _id: 1 } });
  if (found) return /** @type {string} */ (found._id);
  const tenant = newTenant({ name, slug: merchantSlug(name) });
  await tenants.insertOne(tenant, options);
  return tenant._id;
}

/**
 * A new ACTIVE partner QR with an unguessable public token.
 * @param {{ _id: string, tenantId: string, relationshipKind: string }} partner
 * @param {string} createdBy
 * @param {string | null} [replacesMediumId]
 */
export function newReferralMedium(partner, createdBy, replacesMediumId = null) {
  return {
    _id: randomUUID(),
    tenantId: partner.tenantId,
    partnerId: partner._id,
    mediumType: partnerMediumType(partner.relationshipKind),
    publicToken: randomBytes(16).toString('base64url'),
    status: 'ACTIVE',
    replacesMediumId,
    replacedAt: null,
    replacedBy: null,
    replaceReason: null,
    lastActivationAt: null,
    createdBy,
    createdAt: new Date(),
  };
}

/**
 * Case- and spacing-insensitive partner name, unique per merchant.
 * @param {string} name
 */
export function partnerNameKey(name) {
  return name.normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ');
}

/**
 * Stored rule fields. A fixed-amount rule keeps the two rates the validator requires at 0 and adds its
 * amounts as optional fields.
 * @param {import('#domain').CommercialRule | import('#domain').FixedRule} rule
 */
function ruleFields(rule) {
  /** @type {Record<string, unknown>} */
  const fields = {};
  if (isFixedRule(rule)) {
    const fixed = /** @type {import('#domain').FixedRule} */ (rule);
    for (const field of RATE_FIELDS) fields[field] = null;
    fields.totalBudgetRate = toDecimal128('0.0000');
    fields.customerDiscountRate = toDecimal128('0.0000');
    fields.pricingModel = fixed.pricingModel;
    fields.customerDiscountAmount = toDecimal128(fixed.customerDiscountAmount);
    fields.commissionAmount = toDecimal128(fixed.commissionAmount);
    return fields;
  }
  const percents = /** @type {Record<string, string | undefined>} */ (/** @type {unknown} */ (rule));
  for (const field of RATE_FIELDS) fields[field] = percents[field] ? toDecimal128(/** @type {string} */ (percents[field])) : null;
  return fields;
}

/**
 * @param {import('#domain').CommercialRule | import('#domain').FixedRule} rule
 * @param {{ tenantId: string, partnerId: string, version: number, createdBy: string | null, now: Date }} meta
 */
export function newCommercialRule(rule, { tenantId, partnerId, version, createdBy, now }) {
  const rates = ruleFields(rule);
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

/**
 * A new ACTIVE merchant (tenant) document, operated by an organization of the same name.
 * @param {{ name: string, slug: string, contactEmail?: string | null, contactPhone?: string | null, address?: string | null }} input
 */
export function newTenant({ name, slug, contactEmail = null, contactPhone = null, address = null }) {
  return {
    _id: randomUUID(),
    name,
    slug,
    status: 'ACTIVE',
    timezone: 'Asia/Ho_Chi_Minh',
    currency: 'VND',
    internalLanguages: ['en', 'vi'],
    organization: { partyId: randomUUID(), legalName: name, displayName: name, organizationReference: null },
    contactEmail,
    contactPhone,
    address,
    createdAt: new Date(),
  };
}

/**
 * Creates an ACTIVE account (or updates its password) and grants the role if missing.
 * @param {{ email: string, displayName: string, password: string, role: string, tenantId: string | null, partnerRelationshipId?: string | null }} input
 * @param {TxOptions} [options]
 */
export async function ensureActiveUser({ email, displayName, password, role, tenantId, partnerRelationshipId = null }, options = {}) {
  const users = await collection('users');
  const now = new Date();
  const user = await users.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      $set: { passwordHash: await hashPassword(password), passwordChangedAt: now, status: 'ACTIVE', updatedAt: now },
      $setOnInsert: { _id: randomUUID(), displayName, preferredLanguage: 'en', roles: [], createdAt: now },
    },
    { ...options, upsert: true, returnDocument: 'after', projection: { _id: 1 } },
  );
  const userId = /** @type {string} */ (user?._id);
  await grantRole(userId, { role, tenantId, partnerRelationshipId }, options);
  return userId;
}
