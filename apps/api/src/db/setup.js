import { merchantSlug } from '#domain';
import { pathToFileURL } from 'node:url';
import { env, requireEnv } from '../config/env.js';
import { newReferralMedium } from './bootstrap.js';
import { decimalField } from './decimal.js';
import { closeClient, COLLECTIONS, getDb } from './mongo.js';

/**
 * Bump when a validator or index changes. Changes must keep old documents valid
 * (add optional fields; backfill in a script before making a field required).
 */
export const SCHEMA_VERSION = 6;

const DAY_SECONDS = 24 * 60 * 60;
const uuid = { bsonType: 'string', pattern: '^[0-9a-f-]{36}$' };
const nullableUuid = { bsonType: ['string', 'null'], pattern: '^[0-9a-f-]{36}$' };
const date = { bsonType: 'date' };
const nullableDate = { bsonType: ['date', 'null'] };
const text = { bsonType: 'string' };

const TENANT_ROLES = ['TENANT_ADMIN', 'MANAGER', 'STAFF'];

const roleAssignment = {
  bsonType: 'object',
  required: ['_id', 'role', 'scopeType', 'tenantId', 'status', 'validFrom', 'createdAt'],
  properties: {
    _id: uuid,
    role: { enum: ['PLATFORM_ADMIN', ...TENANT_ROLES, 'PARTNER_ADMIN', 'REFERRER'] },
    scopeType: { enum: ['PLATFORM', 'TENANT', 'PARTNER_RELATIONSHIP', 'AFFILIATED_REFERRER'] },
    tenantId: nullableUuid,
    partnerRelationshipId: nullableUuid,
    affiliatedReferrerId: nullableUuid,
    status: { enum: ['ACTIVE', 'ENDED'] },
    validFrom: date,
    validUntil: nullableDate,
    createdAt: date,
    createdBy: nullableUuid,
  },
  anyOf: [
    { properties: { role: { enum: ['PLATFORM_ADMIN'] }, scopeType: { enum: ['PLATFORM'] }, tenantId: { bsonType: 'null' } } },
    { properties: { role: { enum: TENANT_ROLES }, scopeType: { enum: ['TENANT'] }, tenantId: uuid } },
    {
      properties: { role: { enum: ['PARTNER_ADMIN', 'REFERRER'] }, scopeType: { enum: ['PARTNER_RELATIONSHIP'] }, tenantId: uuid },
      required: ['partnerRelationshipId'],
    },
    {
      properties: { role: { enum: ['REFERRER'] }, scopeType: { enum: ['AFFILIATED_REFERRER'] }, tenantId: uuid },
      required: ['affiliatedReferrerId'],
    },
  ],
};

/** Single-use links (invitation, password reset): only the token hash is stored. */
const tokenLink = {
  bsonType: 'object',
  required: ['_id', 'userId', 'tokenHash', 'expiresAt', 'usedAt', 'revokedAt', 'createdAt'],
  properties: {
    _id: uuid,
    userId: uuid,
    tokenHash: { bsonType: 'binData' },
    expiresAt: date,
    usedAt: nullableDate,
    revokedAt: nullableDate,
    createdBy: nullableUuid,
    createdAt: date,
  },
};

/**
 * @type {Record<string, {
 *   schema: import('mongodb').Document,
 *   indexes: import('mongodb').IndexDescription[],
 * }>}
 */
const DEFINITIONS = {
  [COLLECTIONS.tenants]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'name', 'status', 'timezone', 'currency', 'internalLanguages', 'organization', 'createdAt'],
      properties: {
        _id: uuid,
        name: text,
        status: { enum: ['ACTIVE', 'PAUSED', 'ENDED'] },
        timezone: text,
        currency: text,
        internalLanguages: { bsonType: 'array', items: { enum: ['en', 'vi'] } },
        organization: {
          bsonType: 'object',
          required: ['partyId', 'legalName', 'displayName'],
          properties: { partyId: uuid, legalName: text, displayName: text, organizationReference: { bsonType: ['string', 'null'] } },
        },
        createdAt: date,
      },
    },
    // slug, contactEmail, contactPhone, address, vatRate are optional and not in the validator: changing
    // an existing validator needs collMod, which the UAT database user may not run.
    indexes: [
      { key: { name: 1 }, name: 'name_uq', unique: true },
      { key: { slug: 1 }, name: 'slug_uq', unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
    ],
  },

  [COLLECTIONS.users]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'email', 'displayName', 'status', 'preferredLanguage', 'roles', 'createdAt', 'updatedAt'],
      properties: {
        _id: uuid,
        email: { bsonType: 'string', pattern: '^[^A-Z]+$' },
        displayName: text,
        status: { enum: ['INVITED', 'ACTIVE', 'BLOCKED', 'ENDED'] },
        preferredLanguage: { enum: ['en', 'vi'] },
        passwordHash: { bsonType: ['string', 'null'] },
        passwordChangedAt: nullableDate,
        roles: { bsonType: 'array', items: roleAssignment },
        createdAt: date,
        updatedAt: date,
      },
      anyOf: [
        { properties: { status: { enum: ['INVITED', 'BLOCKED', 'ENDED'] } } },
        { properties: { status: { enum: ['ACTIVE'] }, passwordHash: text }, required: ['passwordHash'] },
      ],
    },
    indexes: [
      { key: { email: 1 }, name: 'email_uq', unique: true },
      { key: { 'roles._id': 1 }, name: 'role_assignment_id' },
      { key: { 'roles.tenantId': 1, 'roles.status': 1 }, name: 'role_tenant_status' },
    ],
  },

  [COLLECTIONS.sessions]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'tokenHash', 'userId', 'roleAssignmentId', 'supportSession', 'createdAt', 'lastSeenAt',
        'idleExpiresAt', 'absoluteExpiresAt', 'revokedAt'],
      properties: {
        _id: uuid,
        tokenHash: { bsonType: 'binData' },
        userId: uuid,
        roleAssignmentId: nullableUuid,
        supportSession: { bsonType: 'bool' },
        createdAt: date,
        lastSeenAt: date,
        idleExpiresAt: date,
        absoluteExpiresAt: date,
        revokedAt: nullableDate,
        ip: text,
        userAgent: text,
      },
    },
    indexes: [
      { key: { tokenHash: 1 }, name: 'token_hash_uq', unique: true },
      { key: { userId: 1 }, name: 'user', partialFilterExpression: { revokedAt: null } },
      { key: { absoluteExpiresAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
    ],
  },

  [COLLECTIONS.invitations]: {
    schema: tokenLink,
    indexes: [
      { key: { tokenHash: 1 }, name: 'token_hash_uq', unique: true },
      { key: { userId: 1 }, name: 'user_open', partialFilterExpression: { usedAt: null, revokedAt: null } },
      { key: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 30 * DAY_SECONDS },
    ],
  },

  [COLLECTIONS.passwordResets]: {
    schema: tokenLink,
    indexes: [
      { key: { tokenHash: 1 }, name: 'token_hash_uq', unique: true },
      { key: { userId: 1 }, name: 'user_open', partialFilterExpression: { usedAt: null, revokedAt: null } },
      { key: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 30 * DAY_SECONDS },
    ],
  },

  [COLLECTIONS.rateLimits]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'key', 'windowStart', 'count', 'expiresAt'],
      properties: { _id: text, key: text, windowStart: date, count: { bsonType: ['int', 'long'] }, expiresAt: date },
    },
    indexes: [
      { key: { key: 1 }, name: 'key' },
      { key: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
    ],
  },

  [COLLECTIONS.auditEvents]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'eventType', 'supportSession', 'createdAt'],
      properties: {
        _id: uuid,
        tenantId: nullableUuid,
        actorUserId: nullableUuid,
        actorRoleAssignmentId: nullableUuid,
        eventType: text,
        entityType: { bsonType: ['string', 'null'] },
        entityId: { bsonType: ['string', 'null'] },
        reason: { bsonType: ['string', 'null'] },
        correlationId: { bsonType: ['string', 'null'] },
        supportSession: { bsonType: 'bool' },
        createdAt: date,
      },
    },
    indexes: [
      { key: { tenantId: 1, createdAt: -1 }, name: 'tenant_created' },
      { key: { entityType: 1, entityId: 1 }, name: 'entity' },
    ],
  },

  // No additionalProperties: false, so the REFERRAL channel (Đợt B) can add fields without collMod.
  [COLLECTIONS.vouchers]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'tenantId', 'code', 'source', 'status', 'discountType', 'discountValue', 'validUntil', 'createdBy', 'createdAt'],
      properties: {
        _id: uuid,
        tenantId: uuid,
        code: { bsonType: 'string', pattern: '^[A-HJ-NP-Z2-9]{8}$' },
        source: { enum: ['DIRECT', 'REFERRAL'] },
        status: { enum: ['ACTIVE', 'REDEEMED', 'EXPIRED', 'VOID'] },
        discountType: { enum: ['PERCENT', 'AMOUNT'] },
        discountValue: decimalField,
        minBillAmount: { bsonType: ['decimal', 'null'] },
        validUntil: date,
        customerName: { bsonType: ['string', 'null'] },
        note: { bsonType: ['string', 'null'] },
        batchId: nullableUuid,
        createdBy: uuid,
        createdAt: date,
        redemption: {
          bsonType: ['object', 'null'],
          required: ['grossAmount', 'discountAmount', 'payableAmount', 'redeemedBy', 'redeemedAt'],
          properties: {
            grossAmount: decimalField,
            discountAmount: decimalField,
            payableAmount: decimalField,
            redeemedBy: uuid,
            roleAssignmentId: nullableUuid,
            redeemedAt: date,
          },
        },
        voidedAt: nullableDate,
        voidedBy: nullableUuid,
        voidReason: { bsonType: ['string', 'null'] },
      },
      anyOf: [
        { properties: { status: { enum: ['ACTIVE', 'EXPIRED', 'VOID'] } } },
        { properties: { status: { enum: ['REDEEMED'] }, redemption: { bsonType: 'object' } }, required: ['redemption'] },
      ],
    },
    indexes: [
      { key: { code: 1 }, name: 'code_uq', unique: true },
      { key: { tenantId: 1, createdAt: -1 }, name: 'tenant_created' },
      { key: { tenantId: 1, status: 1, validUntil: 1 }, name: 'tenant_status' },
      { key: { batchId: 1 }, name: 'batch', partialFilterExpression: { batchId: { $type: 'string' } } },
      { key: { mediumId: 1, browserContextId: 1, status: 1 }, name: 'referral_browser', partialFilterExpression: { source: 'REFERRAL' } },
      { key: { partnerId: 1, createdAt: -1 }, name: 'referral_partner', partialFilterExpression: { source: 'REFERRAL' } },
    ],
  },

  // Partner relationship (plan §9.2). Never deleted: ENDED keeps the history.
  [COLLECTIONS.partners]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'tenantId', 'name', 'nameKey', 'relationshipKind', 'partnerType', 'status', 'createdBy', 'createdAt', 'updatedAt'],
      properties: {
        _id: uuid,
        tenantId: uuid,
        name: text,
        nameKey: text,
        relationshipKind: { enum: ['COMPANY', 'INDEPENDENT_INDIVIDUAL'] },
        partnerType: { enum: ['HOTEL', 'RESTAURANT', 'TOUR_GUIDE', 'DRIVER', 'OTHER'] },
        status: { enum: ['ONBOARDING', 'ACTIVE', 'PAUSED', 'ENDED'] },
        contactName: { bsonType: ['string', 'null'] },
        contactPhone: { bsonType: ['string', 'null'] },
        contactEmail: { bsonType: ['string', 'null'] },
        note: { bsonType: ['string', 'null'] },
        createdBy: uuid,
        createdAt: date,
        updatedAt: date,
        endedAt: nullableDate,
        endedBy: nullableUuid,
        endReason: { bsonType: ['string', 'null'] },
      },
    },
    indexes: [
      { key: { tenantId: 1, nameKey: 1 }, name: 'tenant_name_uq', unique: true },
      { key: { tenantId: 1, status: 1, name: 1 }, name: 'tenant_status' },
    ],
  },

  // Commercial rule versions (plan §9.3): one ACTIVE per partner; vouchers snapshot the rates they were issued with.
  [COLLECTIONS.commercialRules]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'tenantId', 'partnerId', 'version', 'status', 'relationshipKind', 'totalBudgetRate', 'customerDiscountRate',
        'effectiveFrom', 'createdBy', 'createdAt'],
      properties: {
        _id: uuid,
        tenantId: uuid,
        partnerId: uuid,
        version: { bsonType: 'int', minimum: 1 },
        status: { enum: ['ACTIVE', 'SUPERSEDED'] },
        relationshipKind: { enum: ['COMPANY', 'INDEPENDENT_INDIVIDUAL'] },
        totalBudgetRate: decimalField,
        customerDiscountRate: decimalField,
        companyCommissionRate: { bsonType: ['decimal', 'null'] },
        individualShareRate: { bsonType: ['decimal', 'null'] },
        companyNetCommissionRate: { bsonType: ['decimal', 'null'] },
        individualCommissionRate: { bsonType: ['decimal', 'null'] },
        effectiveFrom: date,
        supersededAt: nullableDate,
        createdBy: uuid,
        createdAt: date,
      },
    },
    indexes: [
      { key: { partnerId: 1, version: 1 }, name: 'partner_version_uq', unique: true },
      { key: { partnerId: 1 }, name: 'partner_active_uq', unique: true, partialFilterExpression: { status: 'ACTIVE' } },
      { key: { tenantId: 1, status: 1 }, name: 'tenant_status' },
    ],
  },

  // Partner QR (plan §9.4). A replaced QR stops working; its visits and vouchers stay.
  [COLLECTIONS.referralMedia]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'tenantId', 'partnerId', 'mediumType', 'publicToken', 'status', 'createdBy', 'createdAt'],
      properties: {
        _id: uuid,
        tenantId: uuid,
        partnerId: uuid,
        mediumType: { enum: ['COMPANY_QR', 'LOCATION_QR', 'PERSONAL_DIGITAL_QR'] },
        publicToken: { bsonType: 'string', pattern: '^[A-Za-z0-9_-]{22}$' },
        status: { enum: ['ACTIVE', 'PAUSED', 'BLOCKED', 'REPLACED'] },
        replacesMediumId: nullableUuid,
        replacedAt: nullableDate,
        replacedBy: nullableUuid,
        replaceReason: { bsonType: ['string', 'null'] },
        lastActivationAt: nullableDate,
        createdBy: uuid,
        createdAt: date,
      },
    },
    indexes: [
      { key: { publicToken: 1 }, name: 'public_token_uq', unique: true },
      { key: { partnerId: 1 }, name: 'partner_active_uq', unique: true, partialFilterExpression: { status: 'ACTIVE' } },
      { key: { tenantId: 1, partnerId: 1 }, name: 'tenant_partner' },
    ],
  },

  // Every open of a partner link, for "Referral link opens" (plan J11). No personal data.
  [COLLECTIONS.referralVisits]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'publicToken', 'result', 'visitedAt'],
      properties: {
        _id: uuid,
        publicToken: text,
        tenantId: nullableUuid,
        partnerId: nullableUuid,
        mediumId: nullableUuid,
        browserContextId: nullableUuid,
        result: { enum: ['VALID', 'MEDIUM_INACTIVE', 'PARTNER_INACTIVE', 'NOT_FOUND'] },
        language: { bsonType: ['string', 'null'] },
        visitedAt: date,
      },
    },
    indexes: [
      { key: { tenantId: 1, partnerId: 1, visitedAt: -1 }, name: 'tenant_partner_visited' },
      { key: { mediumId: 1, browserContextId: 1, visitedAt: -1 }, name: 'medium_browser' },
    ],
  },

  // What the merchant owes a partner for one redemption (plan §9.7). Voiding the redemption voids its items.
  [COLLECTIONS.commissionItems]: {
    schema: {
      bsonType: 'object',
      required: ['_id', 'tenantId', 'voucherId', 'redemptionId', 'partnerId', 'obligationType', 'rate', 'baseAmount', 'amount', 'status', 'redeemedAt', 'createdAt'],
      properties: {
        _id: uuid,
        tenantId: uuid,
        voucherId: uuid,
        redemptionId: uuid,
        partnerId: uuid,
        mediumId: nullableUuid,
        ruleId: nullableUuid,
        ruleVersion: { bsonType: ['int', 'null'] },
        obligationType: { enum: ['TENANT_TO_COMPANY', 'COMPANY_TO_AFFILIATED_INDIVIDUAL', 'TENANT_TO_INDEPENDENT_INDIVIDUAL'] },
        rate: decimalField,
        baseAmount: decimalField,
        amount: decimalField,
        status: { enum: ['OPEN', 'PAID', 'VOID'] },
        redeemedAt: date,
        createdAt: date,
        voidedAt: nullableDate,
        voidedBy: nullableUuid,
        voidReason: { bsonType: ['string', 'null'] },
      },
    },
    indexes: [
      { key: { redemptionId: 1, obligationType: 1 }, name: 'redemption_obligation_uq', unique: true },
      { key: { tenantId: 1, partnerId: 1, status: 1 }, name: 'tenant_partner_status' },
      { key: { partnerId: 1, redeemedAt: -1 }, name: 'partner_redeemed' },
    ],
  },

  [COLLECTIONS.schemaVersions]: {
    schema: { bsonType: 'object', required: ['_id', 'appliedAt'], properties: { _id: { bsonType: 'int' }, appliedAt: date } },
    indexes: [],
  },
};

/**
 * Fills fields added after documents were created. Idempotent.
 * @param {import('mongodb').Db} db
 */
async function backfill(db) {
  const tenants = db.collection(COLLECTIONS.tenants);
  for (const tenant of await tenants.find({ slug: { $exists: false } }, { projection: { name: 1 } }).toArray()) {
    const base = merchantSlug(tenant.name) || 'merchant';
    let slug = base;
    for (let n = 2; await tenants.countDocuments({ slug }, { limit: 1 }); n++) slug = `${base}-${n}`;
    await tenants.updateOne({ _id: tenant._id, slug: { $exists: false } }, { $set: { slug } });
  }

  const partners = db.collection(COLLECTIONS.partners);
  const media = db.collection(COLLECTIONS.referralMedia);
  const withQr = new Set(await media.distinct('partnerId', { status: { $in: ['ACTIVE', 'PAUSED'] } }));
  for (const partner of await partners.find({ status: { $in: ['ACTIVE', 'PAUSED'] } }).toArray()) {
    if (withQr.has(partner._id)) continue;
    await media.insertOne(newReferralMedium(partner, partner.createdBy));
  }
}

/**
 * Creates missing collections, applies validators and indexes. Safe to run on every deploy.
 * @param {import('mongodb').Db} db
 */
export async function setup(db) {
  const existing = new Map((await db.listCollections().toArray()).map((c) => [c.name, c.options?.validator]));
  for (const [name, { schema, indexes }] of Object.entries(DEFINITIONS)) {
    const validator = { $jsonSchema: schema };
    if (existing.has(name)) {
      // Atlas users created by the Vercel integration may not run collMod, so only call it on a real change.
      if (JSON.stringify(existing.get(name)) !== JSON.stringify(validator)) {
        await db
          .command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' })
          .catch((error) => {
            if (error?.codeName !== 'AtlasError' && error?.code !== 13) throw error;
            throw new Error(`db:setup: validator of "${name}" changed; run with a database user allowed to collMod (${error.message})`);
          });
      }
    } else {
      await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
    }
    if (indexes.length) await db.collection(name).createIndexes(indexes);
  }
  await backfill(db);
  await db
    .collection(COLLECTIONS.schemaVersions)
    .updateOne({ _id: SCHEMA_VERSION }, { $setOnInsert: { appliedAt: new Date() } }, { upsert: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireEnv('mongodbUri');
  try {
    await setup(await getDb());
    console.log(`db:setup: schema v${SCHEMA_VERSION} applied to database "${env.mongodbDb}"`);
  } finally {
    await closeClient();
  }
}
