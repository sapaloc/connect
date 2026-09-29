import { ROLES } from './roles.js';

const { PLATFORM_ADMIN, TENANT_ADMIN, MANAGER, STAFF, PARTNER_ADMIN, REFERRER } = ROLES;

/**
 * Server-side source of truth. The web only uses it to hide what a role cannot do.
 * Scope (tenant / partner / referrer) is checked separately in each query.
 */
export const PERMISSIONS = Object.freeze({
  'surface.console': Object.freeze([PLATFORM_ADMIN, TENANT_ADMIN, MANAGER]),
  'surface.counter': Object.freeze([MANAGER, STAFF]),
  'surface.my': Object.freeze([PARTNER_ADMIN, REFERRER]),
  'merchant.manage': Object.freeze([PLATFORM_ADMIN]),
  'user.list': Object.freeze([PLATFORM_ADMIN, TENANT_ADMIN]),
  'user.invite': Object.freeze([PLATFORM_ADMIN, TENANT_ADMIN]),
  'user.reset_link': Object.freeze([PLATFORM_ADMIN, TENANT_ADMIN]),
  'commercial_rule.manage': Object.freeze([TENANT_ADMIN]),
  'voucher.validate': Object.freeze([MANAGER, STAFF]),
  'redemption.create': Object.freeze([MANAGER, STAFF]),
  'redemption.void': Object.freeze([MANAGER]),
});

/** @typedef {keyof typeof PERMISSIONS} Permission */

/**
 * @param {string | null | undefined} role
 * @param {string} permission
 */
export function can(role, permission) {
  if (!role) return false;
  return PERMISSIONS[permission]?.includes(role) ?? false;
}

/** @param {string | null | undefined} role */
export function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((permission) => can(role, permission));
}

/** @param {string} path */
export function surfaceOf(path) {
  const segment = path.split('/')[1];
  return segment === 'console' || segment === 'counter' || segment === 'my' ? segment : null;
}
