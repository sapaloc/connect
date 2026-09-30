import { fixedRuleFromAmounts, partnerAccountRole, passwordPolicyErrors, RELATIONSHIP_KINDS, ROLES } from '#domain';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canSeedTestAccounts, env, requireEnv } from '../config/env.js';
import { ensureActiveUser, ensureTenant, grantRole, newCommercialRule, newReferralMedium, partnerNameKey } from './bootstrap.js';
import { closeClient, collection } from './mongo.js';
import { withTransaction } from './tx.js';

export const SEED_TENANT = 'Number160';

export const SEED_USERS = Object.freeze([
  { email: 'platform@connect.local', displayName: 'Platform Admin', roles: [ROLES.PLATFORM_ADMIN] },
  { email: 'admin@number160.local', displayName: 'Tenant Admin', roles: [ROLES.TENANT_ADMIN] },
  { email: 'manager@number160.local', displayName: 'Manager', roles: [ROLES.MANAGER] },
  { email: 'staff@number160.local', displayName: 'Staff', roles: [ROLES.STAFF] },
]);

/** A second sample merchant, so one partner account can be shown working with two merchants. */
export const SEED_SECOND_MERCHANT = Object.freeze({
  name: 'Nhà hàng Demo',
  admin: { email: 'admin@nhahang.local', displayName: 'Restaurant Admin' },
});

/**
 * Referral side of the sample merchants, each partner with its MyConnect account.
 * `partner@number160.local` is the partner of both merchants (one account, one role per merchant).
 */
export const SEED_PARTNERS = Object.freeze([
  {
    merchant: SEED_TENANT,
    name: 'Khách sạn Demo',
    partnerType: 'HOTEL',
    relationshipKind: RELATIONSHIP_KINDS.COMPANY,
    rule: { customerDiscountAmount: '100000', commissionAmount: '150000' },
    account: { email: 'partner@number160.local', displayName: 'Partner Admin' },
  },
  {
    merchant: SEED_TENANT,
    name: 'Hướng dẫn viên Demo',
    partnerType: 'TOUR_GUIDE',
    relationshipKind: RELATIONSHIP_KINDS.INDEPENDENT_INDIVIDUAL,
    rule: { customerDiscountAmount: '50000', commissionAmount: '100000' },
    account: { email: 'referrer@number160.local', displayName: 'Referrer' },
  },
  {
    merchant: SEED_TENANT,
    name: 'Tài xế Demo',
    partnerType: 'DRIVER',
    relationshipKind: RELATIONSHIP_KINDS.INDEPENDENT_INDIVIDUAL,
    rule: { customerDiscountAmount: '50000', commissionAmount: '70000' },
    account: { email: 'taixe.demo@example.com', displayName: 'Tài xế Demo' },
  },
  {
    merchant: SEED_SECOND_MERCHANT.name,
    name: 'Khách sạn Demo',
    partnerType: 'HOTEL',
    relationshipKind: RELATIONSHIP_KINDS.COMPANY,
    rule: { customerDiscountAmount: '50000', commissionAmount: '80000' },
    account: { email: 'partner@number160.local', displayName: 'Partner Admin' },
  },
]);

/** @param {string} password */
export function seed(password) {
  return withTransaction(async (session) => {
    const tenantId = await ensureTenant(SEED_TENANT, { session });
    for (const user of SEED_USERS) {
      for (const role of user.roles) {
        await ensureActiveUser(
          {
            email: user.email,
            displayName: user.displayName,
            password,
            role,
            tenantId: role === ROLES.PLATFORM_ADMIN ? null : tenantId,
          },
          { session },
        );
      }
    }
    return tenantId;
  });
}

/**
 * Adds whatever is missing of SEED_SECOND_MERCHANT and SEED_PARTNERS (merchant admin, partner, rule v1,
 * QR, account or extra partner role). Existing partners, accounts and passwords are left as they are.
 * Returns what was added, as "email (merchant)".
 * @param {string} password
 */
export function seedPartners(password) {
  return withTransaction(async (session) => {
    const users = await collection('users');
    const admin = await users.findOne({ email: 'admin@number160.local' }, { session, projection: { _id: 1 } });
    if (!admin) throw new Error('seed partners: admin@number160.local is missing, run the base seed first');
    /** @type {string[]} */
    const created = [];
    /** @type {Map<string, { tenantId: string, createdBy: string }>} */
    const merchants = new Map([[SEED_TENANT, { tenantId: await ensureTenant(SEED_TENANT, { session }), createdBy: admin._id }]]);

    const second = SEED_SECOND_MERCHANT;
    const secondTenantId = await ensureTenant(second.name, { session });
    let secondAdmin = await users.findOne({ email: second.admin.email }, { session, projection: { _id: 1 } });
    if (!secondAdmin) {
      const role = ROLES.TENANT_ADMIN;
      secondAdmin = { _id: await ensureActiveUser({ ...second.admin, password, role, tenantId: secondTenantId }, { session }) };
      created.push(`${second.admin.email} (${second.name})`);
    }
    merchants.set(second.name, { tenantId: secondTenantId, createdBy: secondAdmin._id });

    const partners = await collection('partners');
    for (const sample of SEED_PARTNERS) {
      const { tenantId, createdBy } = /** @type {{ tenantId: string, createdBy: string }} */ (merchants.get(sample.merchant));
      const nameKey = partnerNameKey(sample.name);
      let partner = await partners.findOne({ tenantId, nameKey }, { session });
      if (!partner) {
        const { rule, errors } = fixedRuleFromAmounts({ relationshipKind: sample.relationshipKind, ...sample.rule });
        if (!rule) throw new Error(`seed rule for ${sample.name} is invalid: ${errors.join(', ')}`);
        const now = new Date();
        partner = {
          _id: randomUUID(),
          tenantId,
          name: sample.name,
          nameKey,
          relationshipKind: sample.relationshipKind,
          partnerType: sample.partnerType,
          status: 'ACTIVE',
          contactName: sample.account.displayName,
          contactPhone: null,
          contactEmail: sample.account.email,
          note: null,
          createdBy,
          createdAt: now,
          updatedAt: now,
          endedAt: null,
          endedBy: null,
          endReason: null,
        };
        await partners.insertOne(partner, { session });
        const commercialRules = await collection('commercialRules');
        await commercialRules.insertOne(newCommercialRule(rule, { tenantId, partnerId: partner._id, version: 1, createdBy, now }), { session });
        const referralMedia = await collection('referralMedia');
        await referralMedia.insertOne(newReferralMedium(/** @type {any} */ (partner), createdBy), { session });
      }
      const role = partnerAccountRole(sample.relationshipKind);
      const existing = await users.findOne({ email: sample.account.email }, { session, projection: { roles: 1 } });
      if (!existing) {
        await ensureActiveUser({ ...sample.account, password, role, tenantId, partnerRelationshipId: partner._id }, { session });
      } else if (!existing.roles.some((/** @type {any} */ assignment) => assignment.partnerRelationshipId === partner._id)) {
        await grantRole(existing._id, { role, tenantId, partnerRelationshipId: partner._id, createdBy }, { session });
      } else {
        continue;
      }
      created.push(`${sample.account.email} (${sample.merchant})`);
    }
    return created;
  });
}

/** True once any seed account exists, so later runs never touch passwords or roles changed during testing. */
export async function isSeeded() {
  const users = await collection('users');
  return (await users.countDocuments({ email: { $in: SEED_USERS.map((user) => user.email) } }, { limit: 1 })) > 0;
}

export function assertCanSeed() {
  if (!canSeedTestAccounts) throw new Error(`refused, APP_ENV is "${env.appEnv}" (only local/test/uat)`);
  requireEnv('seedPassword');
  if (passwordPolicyErrors(env.seedPassword).length) throw new Error('SEED_PASSWORD does not meet the password policy');
}

export async function seedOnce() {
  if (await isSeeded()) {
    console.log('seed: test accounts already exist, left unchanged (use pnpm db:reset to start over)');
  } else {
    await seed(env.seedPassword);
    console.log(`seed: ${SEED_USERS.length} accounts in tenant ${SEED_TENANT} (password from SEED_PASSWORD)`);
  }
  const created = await seedPartners(env.seedPassword);
  console.log(created.length ? `seed: partner side added: ${created.join(', ')}` : 'seed: partner side already exists');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertCanSeed();
  requireEnv('mongodbUri');
  try {
    await seedOnce();
  } finally {
    await closeClient();
  }
}
