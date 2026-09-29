import { ROLES } from '#domain';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import { collection } from './mongo.js';

/** @typedef {{ session?: import('mongodb').ClientSession }} TxOptions */

/**
 * A role assignment embedded in `users.roles`.
 * @param {{ role: string, tenantId: string | null, createdBy?: string | null }} input
 */
export function newRoleAssignment({ role, tenantId, createdBy = null }) {
  const now = new Date();
  return {
    _id: randomUUID(),
    role,
    scopeType: role === ROLES.PLATFORM_ADMIN ? 'PLATFORM' : 'TENANT',
    tenantId,
    partnerRelationshipId: null,
    affiliatedReferrerId: null,
    status: 'ACTIVE',
    validFrom: now,
    validUntil: null,
    createdAt: now,
    createdBy,
  };
}

/**
 * Adds the role unless the user already holds it, active, in the same tenant.
 * @param {string} userId
 * @param {{ role: string, tenantId: string | null, createdBy?: string | null }} input
 * @param {TxOptions} [options]
 */
export async function grantRole(userId, input, options = {}) {
  const users = await collection('users');
  await users.updateOne(
    { _id: userId, roles: { $not: { $elemMatch: { role: input.role, tenantId: input.tenantId, status: 'ACTIVE' } } } },
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
  const tenantId = randomUUID();
  await tenants.insertOne(
    {
      _id: tenantId,
      name,
      status: 'ACTIVE',
      timezone: 'Asia/Ho_Chi_Minh',
      currency: 'VND',
      internalLanguages: ['en', 'vi'],
      organization: { partyId: randomUUID(), legalName: name, displayName: name, organizationReference: null },
      createdAt: new Date(),
    },
    options,
  );
  return tenantId;
}

/**
 * Creates an ACTIVE account (or updates its password) and grants the role if missing.
 * @param {{ email: string, displayName: string, password: string, role: string, tenantId: string | null }} input
 * @param {TxOptions} [options]
 */
export async function ensureActiveUser({ email, displayName, password, role, tenantId }, options = {}) {
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
  await grantRole(userId, { role, tenantId }, options);
  return userId;
}
