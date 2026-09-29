export const ROLES = Object.freeze({
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  TENANT_ADMIN: 'TENANT_ADMIN',
  MANAGER: 'MANAGER',
  STAFF: 'STAFF',
  PARTNER_ADMIN: 'PARTNER_ADMIN',
  REFERRER: 'REFERRER',
});

/** @typedef {keyof typeof ROLES} Role */

/** First screen after sign-in (plan §18.2). */
export const LANDING = Object.freeze({
  PLATFORM_ADMIN: '/console',
  TENANT_ADMIN: '/console',
  MANAGER: '/console',
  STAFF: '/counter',
  PARTNER_ADMIN: '/my',
  REFERRER: '/my',
});

/** Roles each role may invite. Partner Admin / Referrer invitations need partner records. */
export const INVITABLE_ROLES = Object.freeze({
  PLATFORM_ADMIN: Object.freeze([ROLES.TENANT_ADMIN]),
  TENANT_ADMIN: Object.freeze([ROLES.TENANT_ADMIN, ROLES.MANAGER, ROLES.STAFF]),
});

/**
 * @param {string} actorRole
 * @param {string} targetRole
 */
export function canInvite(actorRole, targetRole) {
  return INVITABLE_ROLES[actorRole]?.includes(targetRole) ?? false;
}
