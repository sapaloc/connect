import { can, ROLES, sumAmounts } from '#domain';
import { authed } from '../auth/guard.js';
import { collection } from '../db/mongo.js';
import { sendJson } from '../http/respond.js';
import { sumOf, vnDayStart, vnMonthStart } from '../partners/history.js';
import { MERCHANT_PAYS } from '../partners/stats.js';
import { merchantNames, scopeFilter } from './scope.js';

const WORK_LIMIT = 5;

/**
 * @param {Record<string, unknown>} scope
 * @param {Date} today
 * @param {Date} month
 */
async function redemptionTotals(scope, today, month) {
  const isToday = { $gte: ['$redemption.redeemedAt', today] };
  const vouchers = await collection('vouchers');
  const [row] = await vouchers
    .aggregate([
      { $match: { ...scope, status: 'REDEEMED', 'redemption.redeemedAt': { $gte: month } } },
      {
        $group: {
          _id: null,
          monthCount: { $sum: 1 },
          monthBill: { $sum: '$redemption.grossAmount' },
          monthDiscount: { $sum: '$redemption.discountAmount' },
          todayCount: { $sum: { $cond: [isToday, 1, 0] } },
          todayBill: { $sum: { $cond: [isToday, '$redemption.grossAmount', 0] } },
          todayDiscount: { $sum: { $cond: [isToday, '$redemption.discountAmount', 0] } },
        },
      },
    ])
    .toArray();
  const [created] = await vouchers
    .aggregate([
      { $match: { ...scope, createdAt: { $gte: month } } },
      { $group: { _id: null, month: { $sum: 1 }, today: { $sum: { $cond: [{ $gte: ['$createdAt', today] }, 1, 0] } } } },
    ])
    .toArray();
  return {
    today: { redemptions: row?.todayCount ?? 0, billTotal: sumOf(row?.todayBill), discountTotal: sumOf(row?.todayDiscount), newVouchers: created?.today ?? 0 },
    month: { redemptions: row?.monthCount ?? 0, billTotal: sumOf(row?.monthBill), discountTotal: sumOf(row?.monthDiscount), newVouchers: created?.month ?? 0 },
  };
}

/**
 * Commission owed, paid this month and waiting for review, plus the partners behind them.
 * @param {Record<string, unknown>} scope
 * @param {Date} month
 * @param {boolean} platform
 */
async function commissionTotals(scope, month, platform) {
  const items = await collection('commissionItems');
  const unpaid = await items
    .aggregate([
      { $match: { ...scope, status: 'OPEN', obligationType: { $in: MERCHANT_PAYS } } },
      { $group: { _id: '$partnerId', tenantId: { $first: '$tenantId' }, amount: { $sum: '$amount' } } },
      { $sort: { amount: -1 } },
    ])
    .toArray();
  const payouts = await collection('commissionPayouts');
  const [paid] = await payouts
    .aggregate([{ $match: { ...scope, paidAt: { $gte: month } } }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }])
    .toArray();
  const reviews = await collection('commissionReviews');
  const waiting = await reviews
    .aggregate([
      { $match: { ...scope, status: 'PENDING' } },
      { $group: { _id: '$partnerId', tenantId: { $first: '$tenantId' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { count: -1, amount: -1 } },
    ])
    .toArray();

  const ids = [...new Set([...unpaid, ...waiting].map((row) => row._id))];
  const partners = await collection('partners');
  const names = new Map((await partners.find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray()).map((p) => [p._id, p.name]));
  const merchants = platform ? await merchantNames([...unpaid, ...waiting].map((row) => row.tenantId)) : new Map();
  /** @param {any} row */
  const who = (row) => ({ partnerId: row._id, name: names.get(row._id) ?? '', ...(platform ? { merchantName: merchants.get(row.tenantId) ?? null } : {}) });

  return {
    commission: {
      unpaid: sumAmounts(unpaid.map((row) => sumOf(row.amount))),
      unpaidPartners: unpaid.length,
      paidThisMonth: sumOf(paid?.amount),
      paymentsThisMonth: paid?.count ?? 0,
      waitingAmount: sumAmounts(waiting.map((row) => sumOf(row.amount))),
      waitingBills: waiting.reduce((total, row) => total + row.count, 0),
    },
    work: {
      reviews: waiting.slice(0, WORK_LIMIT).map((row) => ({ ...who(row), count: row.count, amount: sumOf(row.amount) })),
      unpaid: unpaid.slice(0, WORK_LIMIT).map((row) => ({ ...who(row), amount: sumOf(row.amount) })),
    },
  };
}

/**
 * Console → Overview: today and this month in Vietnam time. Commission amounts and the work list only
 * for roles that see commission (Merchant admin, Platform admin); a Manager sees counts and discounts.
 * @type {import('../http/router.js').Handler}
 */
async function dashboard(req, res, ctx) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const scope = scopeFilter(session, params.get('merchantId'));
  const now = new Date();
  const month = vnMonthStart(now);
  const totals = await redemptionTotals(scope, vnDayStart(now), month);
  const withCommission = can(session.role, 'commission.list');
  sendJson(res, 200, {
    ...totals,
    withCommission,
    ...(withCommission ? await commissionTotals(scope, month, session.role === ROLES.PLATFORM_ADMIN) : {}),
  });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const dashboardRoutes = [{ method: 'GET', path: '/api/v1/dashboard', handler: authed(dashboard, { permission: 'voucher.list' }) }];
