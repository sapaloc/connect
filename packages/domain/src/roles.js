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

/** @typedef {'PLATFORM' | 'MERCHANT' | 'PARTNER'} RoleSide */

/**
 * @param {string} role
 * @returns {RoleSide}
 */
export function roleSide(role) {
  if (role === ROLES.PLATFORM_ADMIN) return 'PLATFORM';
  if (role === ROLES.PARTNER_ADMIN || role === ROLES.REFERRER) return 'PARTNER';
  return 'MERCHANT';
}

/**
 * Why `role` in `tenantId` cannot join the person's active assignments, or null.
 * A person stays on one side: platform, merchant team or partner. A partner may work with many
 * merchants, through one partner record each; a merchant team member holds one role per merchant.
 * @param {{ role: string, tenantId: string | null, partnerRelationshipId?: string | null }[]} assignments active assignments only
 * @param {{ role: string, tenantId: string | null, partnerRelationshipId?: string | null }} next
 * @returns {'ROLE_SIDE_CONFLICT' | 'ROLE_ALREADY_IN_MERCHANT' | 'PARTNER_ALREADY_IN_MERCHANT' | null}
 */
export function roleConflict(assignments, { role, tenantId, partnerRelationshipId = null }) {
  const side = roleSide(role);
  for (const assignment of assignments) {
    if (roleSide(assignment.role) !== side) return 'ROLE_SIDE_CONFLICT';
    if (side === 'MERCHANT' && assignment.tenantId === tenantId && assignment.role !== role) return 'ROLE_ALREADY_IN_MERCHANT';
    if (side === 'PARTNER' && assignment.tenantId === tenantId && (assignment.partnerRelationshipId ?? null) !== partnerRelationshipId) {
      return 'PARTNER_ALREADY_IN_MERCHANT';
    }
  }
  return null;
}
