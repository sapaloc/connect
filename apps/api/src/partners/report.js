import { formatVoucherCode, sumAmounts } from '#domain';
import { authed } from '../auth/guard.js';
import { fromDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';
import { HttpError } from '../http/errors.js';
import { sendCsv, sendJson } from '../http/respond.js';
import { UUID_PATTERN } from '../merchants/scope.js';
import { myPartnerOf, vnMonthStart } from './history.js';
import { MERCHANT_PAYS } from './stats.js';

const VN_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS = ['this_month', 'last_month'];
const REPORT_STATUSES = ['OPEN', 'PAID', 'PENDING', 'VOID'];
/** @type {Record<string, string>} */
const CSV_STATUS = { OPEN: 'UNPAID', PAID: 'PAID', PENDING: 'WAITING_FOR_REVIEW', VOID: 'VOID', REJECTED: 'REJECTED', NONE: 'NONE' };

/**
 * @typedef {{ from: string, to: string, range: { $gte: Date, $lt: Date } }} Period
 * @typedef {{
 *   redemptionId: string | null, redeemedAt: Date, code: string, partnerId: string, voided: boolean,
 *   grossAmount: string, discountAmount: string, payableAmount: string,
 *   commission: { status: string, amount: string, paidAt: Date | null, note: string | null },
 * }} Bill
 */

/** @param {string} field */
const invalid = (field) => new HttpError(422, 'VALIDATION', `${field} is invalid`, { details: { field } });

/** @param {Date} at */
const vnIso = (at) => new Date(at.getTime() + VN_OFFSET_MS).toISOString();

/** Vietnam calendar date of an instant, YYYY-MM-DD. @param {Date} at */
export const vnDate = (at) => vnIso(at).slice(0, 10);

/** @param {Date} at */
const vnDateTime = (at) => `${vnIso(at).slice(0, 10)} ${vnIso(at).slice(11, 16)}`;

/**
 * 00:00 in Vietnam of a YYYY-MM-DD calendar date.
 * @param {string | null} value
 * @param {string} field
 */
function vnMidnight(value, field) {
  if (!value || !DATE_PATTERN.test(value)) throw invalid(field);
  const at = new Date(`${value}T00:00:00+07:00`);
  if (Number.isNaN(at.getTime()) || vnDate(at) !== value) throw invalid(field);
  return at;
}

/**
 * Whole days in Vietnam time, by the bill (redemption) date: `period` this_month | last_month (the
 * default), or `from` and `to` (YYYY-MM-DD, both included, at most 366 days).
 * @param {URLSearchParams} params
 * @param {Date} [now]
 * @returns {Period}
 */
export function reportPeriod(params, now = new Date()) {
  const period = params.get('period');
  const from = params.get('from');
  const to = params.get('to');
  if (from || to) {
    if (period) throw invalid('period');
    const start = vnMidnight(from, 'from');
    const end = new Date(vnMidnight(to, 'to').getTime() + DAY_MS);
    if (end <= start || (end.getTime() - start.getTime()) / DAY_MS > MAX_DAYS) throw invalid('to');
    return { from: /** @type {string} */ (from), to: /** @type {string} */ (to), range: { $gte: start, $lt: end } };
  }
  const chosen = period || 'this_month';
  if (!PERIODS.includes(chosen)) throw invalid('period');
  const offset = chosen === 'this_month' ? 0 : -1;
  const start = vnMonthStart(now, offset);
  const end = vnMonthStart(now, offset + 1);
  return { from: vnDate(start), to: vnDate(new Date(end.getTime() - DAY_MS)), range: { $gte: start, $lt: end } };
}

/**
 * The commission of one bill: its merchant-pays item when there is one, otherwise what its review says.
 * A bill voided while waiting for review counts its held commission as voided.
 * @param {any} item
 * @param {any} review
 * @param {Map<string, string | null>} notes payout note per payout id
 */
function commissionOf(item, review, notes) {
  if (item) {
    return {
      status: item.status,
      amount: fromDecimal128(item.amount),
      paidAt: item.paidAt ?? null,
      note: item.payoutId ? (notes.get(item.payoutId) ?? null) : null,
    };
  }
  if (review?.status === 'PENDING') return { status: 'PENDING', amount: fromDecimal128(review.amount), paidAt: null, note: null };
  if (review?.status === 'CANCELLED') return { status: 'VOID', amount: fromDecimal128(review.amount), paidAt: null, note: null };
  return { status: review?.status === 'REJECTED' ? 'REJECTED' : 'NONE', amount: '0.0000', paidAt: null, note: null };
}

/**
 * Every bill of a partner voucher redeemed in the period, voided ones included, oldest first.
 * @param {{ tenantId: string, partnerId?: string }} owner
 * @param {Period['range']} range
 * @returns {Promise<Bill[]>}
 */
async function reportBills(owner, range) {
  const vouchers = await collection('vouchers');
  const base = { ...owner, source: 'REFERRAL' };
  const projection = { code: 1, partnerId: 1, redemption: 1, voidedRedemptions: 1 };
  const active = await vouchers.find({ ...base, status: 'REDEEMED', 'redemption.redeemedAt': range }, { projection }).toArray();
  const voided = await vouchers.find({ ...base, voidedRedemptions: { $elemMatch: { redeemedAt: range } } }, { projection }).toArray();
  const inRange = (/** @type {Date} */ at) => at >= range.$gte && at < range.$lt;
  const found = [
    ...active.map((voucher) => ({ voucher, redemption: voucher.redemption, voided: false })),
    ...voided.flatMap((voucher) =>
      (voucher.voidedRedemptions ?? [])
        .filter((/** @type {any} */ redemption) => inRange(redemption.redeemedAt))
        .map((/** @type {any} */ redemption) => ({ voucher, redemption, voided: true })),
    ),
  ];

  const ids = found.map(({ redemption }) => redemption.id).filter(Boolean);
  const items = ids.length
    ? await (await collection('commissionItems'))
        .find({ tenantId: owner.tenantId, redemptionId: { $in: ids }, obligationType: { $in: MERCHANT_PAYS } })
        .toArray()
    : [];
  const reviews = ids.length ? await (await collection('commissionReviews')).find({ tenantId: owner.tenantId, redemptionId: { $in: ids } }).toArray() : [];
  const payoutIds = [...new Set(items.map((item) => item.payoutId).filter(Boolean))];
  const payouts = payoutIds.length ? await (await collection('commissionPayouts')).find({ _id: { $in: payoutIds } }, { projection: { note: 1 } }).toArray() : [];
  const itemOf = new Map(items.map((item) => [item.redemptionId, item]));
  const reviewOf = new Map(reviews.map((review) => [review.redemptionId, review]));
  const notes = new Map(payouts.map((payout) => [payout._id, payout.note ?? null]));

  return found
    .map(({ voucher, redemption, voided: isVoided }) => ({
      redemptionId: redemption.id ?? null,
      redeemedAt: redemption.redeemedAt,
      code: voucher.code,
      partnerId: voucher.partnerId,
      voided: isVoided,
      grossAmount: fromDecimal128(redemption.grossAmount),
      discountAmount: fromDecimal128(redemption.discountAmount),
      payableAmount: fromDecimal128(redemption.payableAmount),
      commission: commissionOf(itemOf.get(redemption.id), reviewOf.get(redemption.id), notes),
    }))
    .sort((a, b) => a.redeemedAt.getTime() - b.redeemedAt.getTime() || a.code.localeCompare(b.code));
}

/**
 * Redemptions, bill and discount count only bills that stand (like Overview); commission per status
 * includes the voided bills' commission under VOID.
 * @param {Bill[]} bills
 */
function summary(bills) {
  const standing = bills.filter((bill) => !bill.voided);
  /** @type {Record<string, string>} */
  const commission = Object.fromEntries(
    REPORT_STATUSES.map((status) => [status, sumAmounts(bills.filter((bill) => bill.commission.status === status).map((bill) => bill.commission.amount))]),
  );
  return {
    redemptions: standing.length,
    voidedBills: bills.length - standing.length,
    billTotal: sumAmounts(standing.map((bill) => bill.grossAmount)),
    discountTotal: sumAmounts(standing.map((bill) => bill.discountAmount)),
    commission,
  };
}

/** @param {string[]} ids */
async function partnerNames(ids) {
  if (!ids.length) return new Map();
  const partners = await collection('partners');
  const found = await partners.find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray();
  return new Map(found.map((partner) => [partner._id, partner.name]));
}

/**
 * Quoted cells, CRLF rows and a BOM so Excel opens UTF-8; a leading = + - @ is neutralised so a
 * partner name or payout note never runs as a formula.
 * @param {(string | number)[][]} rows
 */
export function toCsv(rows) {
  const cell = (/** @type {string | number} */ value) => {
    const text = String(value);
    return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  return `\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`;
}

/** @param {Bill} bill */
const commissionCells = (bill) => [
  bill.commission.amount,
  CSV_STATUS[bill.commission.status] ?? bill.commission.status,
  bill.commission.paidAt ? vnDate(bill.commission.paidAt) : '',
  bill.commission.note ?? '',
];

/**
 * Console → Partners → Report: the Merchant admin's own merchant, optionally one `partnerId`.
 * @param {import('../http/router.js').Context} ctx
 * @param {URLSearchParams} params
 */
async function merchantScope(ctx, params) {
  const session = /** @type {import('../auth/session.js').Session} */ (ctx.session);
  const tenantId = /** @type {string} */ (session.tenantId);
  const partnerId = params.get('partnerId');
  if (!partnerId) return { tenantId };
  const id = partnerId.toLowerCase();
  const partners = await collection('partners');
  if (!UUID_PATTERN.test(id) || !(await partners.findOne({ _id: id, tenantId }, { projection: { _id: 1 } }))) {
    throw new HttpError(404, 'PARTNER_NOT_FOUND', 'Partner not found');
  }
  return { tenantId, partnerId: id };
}

/** @param {import('node:http').IncomingMessage} req */
const paramsOf = (req) => new URL(req.url ?? '/', 'http://localhost').searchParams;

/** @type {import('../http/router.js').Handler} */
async function merchantReport(req, res, ctx) {
  const params = paramsOf(req);
  const period = reportPeriod(params);
  const bills = await reportBills(await merchantScope(ctx, params), period.range);
  /** @type {Map<string, Bill[]>} */
  const byPartner = new Map();
  for (const bill of bills) byPartner.set(bill.partnerId, [...(byPartner.get(bill.partnerId) ?? []), bill]);
  const names = await partnerNames([...byPartner.keys()]);
  const partners = [...byPartner.entries()]
    .map(([partnerId, list]) => ({ partnerId, name: names.get(partnerId) ?? '', ...summary(list) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  sendJson(res, 200, { period: { from: period.from, to: period.to }, partners, totals: summary(bills) });
}

/** @type {import('../http/router.js').Handler} */
async function merchantCsv(req, res, ctx) {
  const params = paramsOf(req);
  const period = reportPeriod(params);
  const bills = await reportBills(await merchantScope(ctx, params), period.range);
  const names = await partnerNames([...new Set(bills.map((bill) => bill.partnerId))]);
  const rows = [
    ['date', 'voucher_code', 'partner', 'bill', 'guest_paid', 'commission', 'commission_status', 'paid_date', 'payout_note'],
    ...bills.map((bill) => [
      vnDateTime(bill.redeemedAt),
      formatVoucherCode(bill.code),
      names.get(bill.partnerId) ?? '',
      bill.grossAmount,
      bill.payableAmount,
      ...commissionCells(bill),
    ]),
  ];
  sendCsv(res, `commission-${period.from}_${period.to}.csv`, toCsv(rows));
}

/**
 * MyConnect: the partner's own bills of the period, without voucher codes or the bill before discount.
 * @type {import('../http/router.js').Handler}
 */
async function myCsv(req, res, ctx) {
  const period = reportPeriod(paramsOf(req));
  const partner = await myPartnerOf(ctx);
  const bills = await reportBills({ tenantId: partner.tenantId, partnerId: partner._id }, period.range);
  const rows = [
    ['date', 'guest_paid', 'commission', 'commission_status', 'paid_date', 'payout_note'],
    ...bills.map((bill) => [vnDateTime(bill.redeemedAt), bill.payableAmount, ...commissionCells(bill)]),
  ];
  sendCsv(res, `commission-${period.from}_${period.to}.csv`, toCsv(rows));
}

/** @type {import('../http/router.js').RouteDef[]} */
export const reportRoutes = [
  { method: 'GET', path: '/api/v1/reports/commission', handler: authed(merchantReport, { permission: 'commission.report' }) },
  { method: 'GET', path: '/api/v1/reports/commission/csv', handler: authed(merchantCsv, { permission: 'commission.report' }) },
  { method: 'GET', path: '/api/v1/my/partner/report/csv', handler: authed(myCsv, { permission: 'commission.view_own' }) },
];
