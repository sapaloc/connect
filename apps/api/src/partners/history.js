import { Decimal128 } from 'mongodb';
import { authed } from '../auth/guard.js';
import { fromDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';
import { HttpError } from '../http/errors.js';
import { sendJson } from '../http/respond.js';
import { scopeFilter, UUID_PATTERN } from '../merchants/scope.js';
import { MERCHANT_PAYS, payoutView } from './stats.js';

const PAGE_SIZE = 20;
const PAYOUT_LIMIT = 50;
const PAYOUT_ITEMS_LIMIT = 500;
const REVIEW_LIMIT = 100;
const HISTORY_STATUSES = ['OPEN', 'PAID', 'VOID', 'PENDING'];
const PERIODS = ['this_month', 'last_month'];
const VN_OFFSET_MS = 7 * 3600_000;

/**
 * A `$sum` result as a 4-decimal string; `$sum` gives the integer 0 when nothing matched.
 * @param {unknown} value
 */
export function sumOf(value) {
  return value instanceof Decimal128 ? fromDecimal128(value) : '0.0000';
}

/**
 * Start of the Vietnam calendar month `offset` months from `now`, as a UTC instant.
 * @param {Date} now
 * @param {number} [offset]
 */
export function vnMonthStart(now, offset = 0) {
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + offset, 1) - VN_OFFSET_MS);
}

/**
 * Midnight of today in Vietnam, as a UTC instant.
 * @param {Date} now
 */
export function vnDayStart(now) {
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - VN_OFFSET_MS);
}

/**
 * `status` OPEN | PAID | VOID | PENDING, `period` this_month | last_month, `before` the `next` cursor of
 * the previous page.
 * @param {import('node:http').IncomingMessage} req
 */
function historyQuery(req) {
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const status = params.get('status') || null;
  if (status && !HISTORY_STATUSES.includes(status)) throw new HttpError(422, 'VALIDATION', 'status is invalid', { details: { field: 'status' } });
  const period = params.get('period') || null;
  if (period && !PERIODS.includes(period)) throw new HttpError(422, 'VALIDATION', 'period is invalid', { details: { field: 'period' } });
  const before = params.get('before');
  /** @type {{ at: Date, id: string } | null} */
  let cursor = null;
  if (before) {
    const [iso = '', id = ''] = before.split('|');
    const at = new Date(iso);
    if (Number.isNaN(at.getTime()) || !UUID_PATTERN.test(id)) throw new HttpError(422, 'VALIDATION', 'before is invalid', { details: { field: 'before' } });
    cursor = { at, id: id.toLowerCase() };
  }
  return { status, period, cursor };
}

/**
 * @param {string | null} period
 * @param {Date} now
 */
function periodRange(period, now) {
  if (period === 'this_month') return { $gte: vnMonthStart(now), $lt: vnMonthStart(now, 1) };
  if (period === 'last_month') return { $gte: vnMonthStart(now, -1), $lt: vnMonthStart(now) };
  return null;
}

/** @param {any} item stored commission item */
function itemRow(item) {
  return {
    id: item._id,
    voucherId: item.voucherId,
    redeemedAt: item.redeemedAt.toISOString(),
    baseAmount: fromDecimal128(item.baseAmount),
    amount: fromDecimal128(item.amount),
    status: item.status,
    paidAt: item.paidAt ? item.paidAt.toISOString() : null,
    payoutId: item.payoutId ?? null,
  };
}

/** @param {any} review stored commission review, still PENDING */
function reviewRow(review) {
  const item = review.items?.find((/** @type {any} */ entry) => MERCHANT_PAYS.includes(entry.obligationType));
  return {
    id: review._id,
    voucherId: review.voucherId,
    redeemedAt: review.createdAt.toISOString(),
    baseAmount: item ? fromDecimal128(item.baseAmount) : '0.0000',
    amount: fromDecimal128(review.amount),
    status: 'PENDING',
    paidAt: null,
    payoutId: null,
  };
}

/**
 * The merchant sees the voucher code of each bill; the partner never does (it only knows the bill
 * time, what the guest paid and its commission).
 * @param {ReturnType<typeof itemRow>[]} rows
 * @param {boolean} withCode
 */
async function finishRows(rows, withCode) {
  /** @type {Map<string, string>} */
  let codes = new Map();
  if (withCode && rows.length) {
    const vouchers = await collection('vouchers');
    const found = await vouchers.find({ _id: { $in: [...new Set(rows.map((row) => row.voucherId))] } }, { projection: { code: 1 } }).toArray();
    codes = new Map(found.map((voucher) => [voucher._id, voucher.code]));
  }
  return rows.map(({ voucherId, ...row }) => (withCode ? { ...row, code: codes.get(voucherId) ?? null } : row));
}

/**
 * One page of a partner's commission, newest first, with the period totals per status. Bills waiting
 * for the merchant's review come first on the first page.
 * @param {any} partner
 * @param {ReturnType<typeof historyQuery>} query
 * @param {{ withCode: boolean }} options
 */
async function commissionHistory(partner, { status, period, cursor }, { withCode }) {
  const range = periodRange(period, new Date());
  const owner = { tenantId: partner.tenantId, partnerId: partner._id };
  const itemFilter = { ...owner, obligationType: { $in: MERCHANT_PAYS }, ...(range ? { redeemedAt: range } : {}) };
  const reviewFilter = { ...owner, status: 'PENDING', ...(range ? { createdAt: range } : {}) };
  const items = await collection('commissionItems');
  const reviews = await collection('commissionReviews');

  /** @type {ReturnType<typeof itemRow>[]} */
  let rows = [];
  /** @type {string | null} */
  let next = null;
  if (status !== 'PENDING') {
    /** @type {Record<string, unknown>} */
    const filter = { ...itemFilter, ...(status ? { status } : {}) };
    if (cursor) filter.$or = [{ redeemedAt: { $lt: cursor.at } }, { redeemedAt: cursor.at, _id: { $lt: cursor.id } }];
    const found = await items.find(filter, { sort: { redeemedAt: -1, _id: -1 }, limit: PAGE_SIZE + 1 }).toArray();
    if (found.length > PAGE_SIZE) {
      found.length = PAGE_SIZE;
      const last = found[PAGE_SIZE - 1];
      next = `${last.redeemedAt.toISOString()}|${last._id}`;
    }
    rows = found.map(itemRow);
  }
  if (!cursor && (!status || status === 'PENDING')) {
    const waiting = await reviews.find(reviewFilter, { sort: { createdAt: -1 }, limit: REVIEW_LIMIT }).toArray();
    rows = [...waiting.map(reviewRow), ...rows];
  }

  /** @type {Record<string, { amount: string, count: number }>} */
  const totals = Object.fromEntries(HISTORY_STATUSES.map((key) => [key, { amount: '0.0000', count: 0 }]));
  for (const row of await items.aggregate([{ $match: itemFilter }, { $group: { _id: '$status', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]).toArray()) {
    totals[row._id] = { amount: sumOf(row.amount), count: row.count };
  }
  const [waitingSum] = await reviews.aggregate([{ $match: reviewFilter }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]).toArray();
  if (waitingSum) totals.PENDING = { amount: sumOf(waitingSum.amount), count: waitingSum.count };

  return { items: await finishRows(rows, withCode), next, totals };
}

/**
 * @param {string[]} userIds
 * @returns {Promise<Map<string, string>>}
 */
async function displayNames(userIds) {
  if (!userIds.length) return new Map();
  const users = await collection('users');
  const found = await users.find({ _id: { $in: [...new Set(userIds)] } }, { projection: { displayName: 1 } }).toArray();
  return new Map(found.map((user) => [user._id, user.displayName]));
}

/**
 * A payout of this partner and the bills it covered.
 * @param {any} partner
 * @param {string} rawId
 * @param {{ withCode: boolean }} options
 */
async function payoutDetail(partner, rawId, { withCode }) {
  const id = String(rawId ?? '').toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new HttpError(404, 'PAYOUT_NOT_FOUND', 'Payment not found');
  const payouts = await collection('commissionPayouts');
  const payout = await payouts.findOne({ _id: id, tenantId: partner.tenantId, partnerId: partner._id });
  if (!payout) throw new HttpError(404, 'PAYOUT_NOT_FOUND', 'Payment not found');
  const items = await collection('commissionItems');
  const covered = await items.find({ payoutId: payout._id, partnerId: partner._id }, { sort: { redeemedAt: -1, _id: -1 }, limit: PAYOUT_ITEMS_LIMIT }).toArray();
  const view = payoutView(payout);
  const paidBy = withCode ? ((await displayNames([payout.paidBy])).get(payout.paidBy) ?? null) : undefined;
  return { payout: withCode ? { ...view, paidByName: paidBy } : view, items: await finishRows(covered.map(itemRow), withCode) };
}

/**
 * The partner of the signed-in Partner admin / Referrer.
 * @param {import('../http/router.js').Context} ctx
 */
async function myPartnerOf(ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const partners = await collection('partners');
  const partner = session.partnerRelationshipId ? await partners.findOne({ _id: session.partnerRelationshipId, tenantId: session.tenantId }) : null;
  if (!partner) throw new HttpError(404, 'PARTNER_NOT_FOUND', 'Partner not found');
  return partner;
}

/**
 * A partner the Merchant admin (own merchant) or Platform admin (any merchant) may see.
 * @param {import('../http/router.js').Context} ctx
 */
async function scopedPartner(ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const id = String(ctx.params.id ?? '').toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new HttpError(404, 'PARTNER_NOT_FOUND', 'Partner not found');
  const partners = await collection('partners');
  const partner = await partners.findOne({ _id: id, ...scopeFilter(session, null) });
  if (!partner) throw new HttpError(404, 'PARTNER_NOT_FOUND', 'Partner not found');
  return partner;
}

/** @type {import('../http/router.js').Handler} */
async function myHistory(req, res, ctx) {
  const query = historyQuery(req);
  sendJson(res, 200, await commissionHistory(await myPartnerOf(ctx), query, { withCode: false }));
}

/** @type {import('../http/router.js').Handler} */
async function myPayout(_req, res, ctx) {
  sendJson(res, 200, await payoutDetail(await myPartnerOf(ctx), ctx.params.payoutId, { withCode: false }));
}

/**
 * Console → Partners → History: bills, and on the first page the payouts with who recorded them.
 * @type {import('../http/router.js').Handler}
 */
async function partnerHistory(req, res, ctx) {
  const query = historyQuery(req);
  const partner = await scopedPartner(ctx);
  const history = await commissionHistory(partner, query, { withCode: true });
  /** @type {any[] | undefined} */
  let payouts;
  if (!query.cursor) {
    const stored = await (await collection('commissionPayouts')).find({ partnerId: partner._id }, { sort: { paidAt: -1 }, limit: PAYOUT_LIMIT }).toArray();
    const names = await displayNames(stored.map((payout) => payout.paidBy));
    payouts = stored.map((payout) => ({ ...payoutView(payout), paidByName: names.get(payout.paidBy) ?? null }));
  }
  sendJson(res, 200, { partner: { id: partner._id, name: partner.name }, ...history, ...(payouts ? { payouts } : {}) });
}

/** @type {import('../http/router.js').Handler} */
async function partnerPayout(_req, res, ctx) {
  sendJson(res, 200, await payoutDetail(await scopedPartner(ctx), ctx.params.payoutId, { withCode: true }));
}

/** @type {import('../http/router.js').RouteDef[]} */
export const historyRoutes = [
  { method: 'GET', path: '/api/v1/my/partner/history', handler: authed(myHistory, { permission: 'commission.view_own' }) },
  { method: 'GET', path: '/api/v1/my/partner/payouts/:payoutId', handler: authed(myPayout, { permission: 'commission.view_own' }) },
  { method: 'GET', path: '/api/v1/partners/:id/history', handler: authed(partnerHistory, { permission: 'commission.list' }) },
  { method: 'GET', path: '/api/v1/partners/:id/payouts/:payoutId', handler: authed(partnerPayout, { permission: 'commission.list' }) },
];
