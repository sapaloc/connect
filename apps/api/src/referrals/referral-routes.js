import { isFixedRule, parseReferralToken, REFERRAL_VALIDITY_DAYS, ROLES } from '#domain';
import { randomUUID } from 'node:crypto';
import { actorOf, recordAudit } from '../audit/audit.js';
import { consume } from '../auth/rate-limit.js';
import { loadSession } from '../auth/session.js';
import { RATE_LIMITS } from '../config/security.js';
import { fromDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { parseCookies, serializeCookie } from '../http/cookies.js';
import { HttpError } from '../http/errors.js';
import { clientIp } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { brandView, UUID_PATTERN } from '../merchants/scope.js';
import { newCodes, publicView } from '../vouchers/voucher-routes.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BROWSER_COOKIE = 'mc_bc';
const BROWSER_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const MERCHANT_ROLES = [ROLES.TENANT_ADMIN, ROLES.MANAGER, ROLES.STAFF];
/** `createdBy` of vouchers activated anonymously from a partner QR (no user account). */
export const PUBLIC_ACTOR_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The anonymous browser id already set on this browser, or null. Never creates one.
 * @param {import('node:http').IncomingMessage} req
 */
export function browserIdOf(req) {
  const current = parseCookies(req.headers.cookie)[BROWSER_COOKIE];
  return current && UUID_PATTERN.test(current) ? current.toLowerCase() : null;
}

/**
 * A browser signed in to a merchant-side role (Admin, Manager, Staff) of this merchant: such a browser
 * may not take or confirm a partner voucher, or staff could confirm their own bill (plan §0.9).
 * @param {import('node:http').IncomingMessage} req
 * @param {string} tenantId
 */
export async function isMerchantBrowser(req, tenantId) {
  return isMerchantSession(await loadSession(req), tenantId);
}

/**
 * @param {import('../auth/session.js').Session | null} session
 * @param {string} tenantId
 */
function isMerchantSession(session, tenantId) {
  return Boolean(session && MERCHANT_ROLES.includes(session.role) && session.tenantId === tenantId);
}

/**
 * The anonymous browser id (plan §9.6): the same browser opening the same QR gets the same voucher back.
 * @param {import('node:http').IncomingMessage} req
 */
function browserContext(req) {
  const current = browserIdOf(req);
  if (current) return { id: current, header: {} };
  const id = randomUUID();
  return { id, header: { 'Set-Cookie': serializeCookie(BROWSER_COOKIE, id, BROWSER_COOKIE_MAX_AGE) } };
}

/**
 * Medium, partner, merchant and rule behind a token, and whether a voucher can be activated from it.
 * @param {string | null} token
 * @param {import('mongodb').ClientSession} [tx]
 */
async function resolve(token, tx) {
  const options = tx ? { session: tx } : {};
  const referralMedia = await collection('referralMedia');
  const medium = token ? await referralMedia.findOne({ publicToken: token }, options) : null;
  if (!medium) return { result: 'NOT_FOUND' };
  if (medium.status !== 'ACTIVE') return { result: 'MEDIUM_INACTIVE', medium };
  const partners = await collection('partners');
  const partner = await partners.findOne({ _id: medium.partnerId }, options);
  const commercialRules = await collection('commercialRules');
  const rule = partner ? await commercialRules.findOne({ partnerId: partner._id, status: 'ACTIVE' }, options) : null;
  const tenants = await collection('tenants');
  const tenant = await tenants.findOne({ _id: medium.tenantId, status: 'ACTIVE' }, { ...options, projection: { name: 1, logoAssetId: 1, brandColor: 1 } });
  if (partner?.status !== 'ACTIVE' || !rule || !tenant) return { result: 'PARTNER_INACTIVE', medium, partner };
  return { result: 'VALID', medium, partner, rule, merchantName: /** @type {string} */ (tenant.name), brand: brandView(tenant) };
}

/** @param {string} result */
function refusal(result) {
  if (result === 'NOT_FOUND') return new HttpError(404, 'REFERRAL_NOT_FOUND', 'This partner link does not exist');
  return new HttpError(410, 'REFERRAL_INACTIVE', 'This partner link no longer works');
}

/**
 * @param {any} partner
 * @param {any} rule
 * @param {string} merchantName
 * @param {any} brand
 */
function referralView(partner, rule, merchantName, brand) {
  return {
    merchantName,
    brand,
    partnerName: partner.name,
    partnerType: partner.partnerType,
    discountRate: isFixedRule(rule) ? null : fromDecimal128(rule.customerDiscountRate),
    discountAmount: isFixedRule(rule) ? fromDecimal128(rule.customerDiscountAmount) : null,
    validityDays: REFERRAL_VALIDITY_DAYS,
  };
}

/**
 * @param {string} mediumId
 * @param {string} browserContextId
 * @param {Date} now
 * @param {import('mongodb').ClientSession} [tx]
 */
async function activeVoucherOf(mediumId, browserContextId, now, tx) {
  const vouchers = await collection('vouchers');
  return vouchers.findOne(
    { source: 'REFERRAL', mediumId, browserContextId, status: 'ACTIVE', validUntil: { $gt: now } },
    tx ? { session: tx } : {},
  );
}

/**
 * Opening a partner link: counted as a visit, even when the link no longer works.
 * @type {import('../http/router.js').Handler}
 */
async function openReferral(req, res, ctx) {
  await consume(`referral-public:${clientIp(req)}`, RATE_LIMITS.publicReferralIp);
  const token = parseReferralToken(ctx.params.token);
  const browser = browserContext(req);
  const found = await resolve(token);
  const now = new Date();
  const visits = await collection('referralVisits');
  await visits.insertOne({
    _id: randomUUID(),
    publicToken: String(ctx.params.token).slice(0, 64),
    tenantId: found.medium?.tenantId ?? null,
    partnerId: found.medium?.partnerId ?? null,
    mediumId: found.medium?._id ?? null,
    browserContextId: browser.id,
    result: found.result,
    language: String(req.headers['accept-language'] ?? '').slice(0, 16) || null,
    visitedAt: now,
  });
  if (found.result !== 'VALID') throw refusal(found.result);

  const voucher = await activeVoucherOf(found.medium._id, browser.id, now);
  sendJson(
    res,
    200,
    {
      referral: referralView(found.partner, found.rule, found.merchantName, found.brand),
      voucher: voucher ? publicView(voucher, found.merchantName, now, found.brand) : null,
    },
    browser.header,
  );
}

/**
 * Anonymous activation (plan §9.6): no phone, no account. The medium is written first inside the
 * transaction, so two taps at once conflict, retry, and the second one finds the first voucher.
 * @type {import('../http/router.js').Handler}
 */
async function activateReferral(req, res, ctx) {
  await consume(`referral-activate:${clientIp(req)}`, RATE_LIMITS.referralActivateIp);
  const token = parseReferralToken(ctx.params.token);
  const browser = browserContext(req);
  const signedIn = await loadSession(req);

  for (let attempt = 1; ; attempt++) {
    try {
      const outcome = await withTransaction(async (tx) => {
        const now = new Date();
        const found = await resolve(token, tx);
        if (found.result !== 'VALID') throw refusal(found.result);
        const { medium, partner, rule } = found;
        if (isMerchantSession(signedIn, medium.tenantId)) {
          throw new HttpError(403, 'REFERRAL_MERCHANT_BROWSER', 'Merchant staff cannot take a partner voucher; the guest takes it on their own phone');
        }
        const referralMedia = await collection('referralMedia');
        await referralMedia.updateOne({ _id: medium._id }, { $set: { lastActivationAt: now } }, { session: tx });

        const existing = await activeVoucherOf(medium._id, browser.id, now, tx);
        if (existing) return { voucher: existing, merchantName: found.merchantName, brand: found.brand, created: false };

        const visits = await collection('referralVisits');
        const visit = await visits.findOne(
          { mediumId: medium._id, browserContextId: browser.id, result: 'VALID' },
          { session: tx, sort: { visitedAt: -1 }, projection: { _id: 1 } },
        );
        const fixed = isFixedRule(rule);
        const voucher = {
          _id: randomUUID(),
          tenantId: medium.tenantId,
          code: newCodes(1)[0],
          source: 'REFERRAL',
          status: 'ACTIVE',
          discountType: fixed ? 'AMOUNT' : 'PERCENT',
          discountValue: fixed ? rule.customerDiscountAmount : rule.customerDiscountRate,
          minBillAmount: null,
          validUntil: new Date(now.getTime() + REFERRAL_VALIDITY_DAYS * DAY_MS),
          customerName: null,
          note: null,
          batchId: null,
          createdBy: PUBLIC_ACTOR_ID,
          createdAt: now,
          redemption: null,
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
          partnerId: partner._id,
          mediumId: medium._id,
          referralVisitId: visit?._id ?? null,
          browserContextId: browser.id,
          activatedAt: now,
          ruleSnapshot: {
            ruleId: rule._id,
            version: rule.version,
            relationshipKind: rule.relationshipKind,
            totalBudgetRate: rule.totalBudgetRate,
            customerDiscountRate: rule.customerDiscountRate,
            companyCommissionRate: rule.companyCommissionRate ?? null,
            individualShareRate: rule.individualShareRate ?? null,
            companyNetCommissionRate: rule.companyNetCommissionRate ?? null,
            individualCommissionRate: rule.individualCommissionRate ?? null,
            ...(fixed ? { pricingModel: rule.pricingModel, customerDiscountAmount: rule.customerDiscountAmount, commissionAmount: rule.commissionAmount } : {}),
          },
        };
        const vouchers = await collection('vouchers');
        await vouchers.insertOne(voucher, { session: tx });
        await recordAudit(
          {
            ...actorOf(ctx),
            tenantId: medium.tenantId,
            eventType: 'VOUCHER_ACTIVATED',
            entityType: 'voucher',
            entityId: voucher._id,
            after: { partnerId: partner._id, mediumId: medium._id, ruleVersion: rule.version, validUntil: voucher.validUntil.toISOString() },
          },
          { session: tx },
        );
        return { voucher, merchantName: found.merchantName, brand: found.brand, created: true };
      });
      sendJson(
        res,
        outcome.created ? 201 : 200,
        { voucher: publicView(outcome.voucher, outcome.merchantName, new Date(), outcome.brand), created: outcome.created },
        browser.header,
      );
      return;
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 11000 || attempt >= 3) throw error;
    }
  }
}

/** @type {import('../http/router.js').RouteDef[]} */
export const referralRoutes = [
  { method: 'GET', path: '/api/v1/public/referrals/:token', handler: openReferral },
  { method: 'POST', path: '/api/v1/public/referrals/:token/activate', handler: activateReferral },
];
