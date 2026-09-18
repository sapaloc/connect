'use strict';
/* Role-based permission matrix (UI hiding alone is not enforcement —
   every mutating route goes through `need()` from middleware.js). */
const POLICY = {
  partner_create: ['tenant_admin', 'platform_admin'],
  partner_approve: ['tenant_admin', 'platform_admin'],
  location_write: ['tenant_admin', 'platform_admin', 'partner_admin'],
  referrer_approve: ['tenant_admin', 'platform_admin'],
  referrer_submit: ['partner_admin', 'tenant_admin', 'platform_admin'],
  referrer_end: ['partner_admin', 'tenant_admin', 'platform_admin'],
  budget_write: ['tenant_admin'],
  media_write: ['tenant_admin', 'platform_admin'],
  card_approve: ['tenant_admin', 'platform_admin'],
  card_request: ['partner_admin', 'referrer', 'tenant_admin', 'platform_admin'],
  content_write: ['tenant_admin'],
  counter_redeem: ['staff160', 'manager160', 'tenant_admin'],
  void: ['manager160', 'tenant_admin'],
  payout_verify_company: ['tenant_admin'],
  payout_verify_affil: ['partner_admin', 'tenant_admin'],
  settle: ['tenant_admin', 'partner_admin'],
  settings: ['tenant_admin', 'platform_admin'],
};

module.exports = { POLICY };
