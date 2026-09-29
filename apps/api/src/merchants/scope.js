import { brandTextColor, ROLES } from '#domain';
import { collection } from '../db/mongo.js';
import { fileUrl } from '../files/files.js';
import { HttpError } from '../http/errors.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string[]} tenantIds */
export async function merchantNames(tenantIds) {
  const tenants = await collection('tenants');
  const rows = await tenants.find({ _id: { $in: [...new Set(tenantIds)] } }, { projection: { name: 1 } }).toArray();
  return new Map(rows.map((tenant) => [tenant._id, tenant.name]));
}

/**
 * Logo and colour shown on the merchant's public pages and voucher cards; null when neither is set.
 * @param {{ logoAssetId?: string | null, brandColor?: string | null } | null | undefined} tenant
 */
export function brandView(tenant) {
  if (!tenant?.logoAssetId && !tenant?.brandColor) return null;
  return {
    logoUrl: fileUrl(tenant.logoAssetId),
    color: tenant.brandColor ?? null,
    textColor: tenant.brandColor ? brandTextColor(tenant.brandColor) : null,
  };
}

/** @param {string[]} tenantIds */
export async function merchantBrands(tenantIds) {
  const tenants = await collection('tenants');
  const rows = await tenants.find({ _id: { $in: [...new Set(tenantIds)] } }, { projection: { logoAssetId: 1, brandColor: 1 } }).toArray();
  return new Map(rows.map((tenant) => [tenant._id, brandView(tenant)]));
}

/**
 * Platform admin sees every merchant (optionally one); merchant roles only their own.
 * @param {import('../auth/session.js').Session} session
 * @param {string | null} requested
 */
export function scopeFilter(session, requested) {
  if (session.role === ROLES.PLATFORM_ADMIN) {
    if (!requested) return {};
    if (!UUID_PATTERN.test(requested)) throw new HttpError(422, 'VALIDATION', 'merchantId is invalid', { details: { field: 'merchantId' } });
    return { tenantId: requested.toLowerCase() };
  }
  return { tenantId: session.tenantId };
}
