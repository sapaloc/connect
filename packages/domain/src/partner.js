import { RELATIONSHIP_KINDS } from './money.js';
import { ROLES } from './roles.js';

export const PARTNER_TYPES = Object.freeze(['HOTEL', 'RESTAURANT', 'TOUR_GUIDE', 'DRIVER', 'OTHER']);

/** First screen of a partner approved from the sign-in page who has joined no merchant yet. */
export const PARTNER_WELCOME_PATH = '/partner/welcome';

/** `ENDED` is final: the partner and its history stay, it just cannot refer anyone again. */
export const PARTNER_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'ENDED']);

/** @param {string} relationshipKind */
export function partnerMediumType(relationshipKind) {
  return relationshipKind === RELATIONSHIP_KINDS.COMPANY ? 'COMPANY_QR' : 'PERSONAL_DIGITAL_QR';
}

/**
 * MyConnect role of a partner's account: a company is run by a Partner admin, an independent
 * individual is its own Referrer.
 * @param {string} relationshipKind
 */
export function partnerAccountRole(relationshipKind) {
  return relationshipKind === RELATIONSHIP_KINDS.COMPANY ? ROLES.PARTNER_ADMIN : ROLES.REFERRER;
}
