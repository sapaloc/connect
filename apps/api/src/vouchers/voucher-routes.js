import {
  calculateDirectRedemption,
  calculateRedemption,
  can,
  effectiveVoucherStatus,
  MoneyError,
  parseDecimal,
  parseDirectDiscount,
  parseVoucherCode,
  VOUCHER_BATCH_MAX,
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_LENGTH,
} from '#domain';
import { randomInt, randomUUID } from 'node:crypto';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { consume } from '../auth/rate-limit.js';
import { loadSession } from '../auth/session.js';
import { RATE_LIMITS } from '../config/security.js';
import { fromDecimal128, toDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { clientIp, readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { merchantBrands, merchantNames, scopeFilter, UUID_PATTERN } from '../merchants/scope.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_VALIDITY_DAYS = 366;
const LIST_LIMIT = 100;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const STATUS_FILTERS = ['ACTIVE', 'REDEEMED', 'EXPIRED', 'VOID'];

/** @param {import('../http/router.js').Context} ctx */
function sessionOf(ctx) {
  return /** @type {import('../auth/session.js').Session} */ (ctx.session);
}

/** @param {unknown} error */
function moneyToHttp(error) {
  if (error instanceof MoneyError) {
    return new HttpError(422, error.code === 'BELOW_MIN_BILL' ? 'BELOW_MIN_BILL' : 'VALIDATION', error.message, {
      details: { field: error.field === 'grossInvoiceAmount' ? 'grossAmount' : error.field },
    });
  }
  return error;
}

const RULE_RATES = /** @type {const} */ ([
  'totalBudgetRate',
  'customerDiscountRate',
  'companyCommissionRate',
  'individualShareRate',
  'companyNetCommissionRate',
  'individualCommissionRate',
]);

/**
 * The partner's rule as it was when the customer activated the voucher.
 * @param {any} snapshot `voucher.ruleSnapshot`
 * @returns {import('#domain').CommercialRule}
 */
function snapshotRule(snapshot) {
  /** @type {Record<string, string | null>} */
  const rates = {};
  for (const field of RULE_RATES) rates[field] = snapshot[field] ? fromDecimal128(snapshot[field]) : null;
  return /** @type {any} */ ({ relationshipKind: snapshot.relationshipKind, ...rates });
}

/**
 * Referral redemption: Net/Net commission from the rule snapshot and the merchant VAT at redemption.
 * @param {any} voucher
 * @param {unknown} grossAmount
 * @param {import('mongodb').ClientSession} tx
 */
async function referralAmounts(voucher, grossAmount, tx) {
  const tenants = await collection('tenants');
  const tenant = await tenants.findOne({ _id: voucher.tenantId }, { session: tx, projection: { vatRate: 1 } });
  if (!tenant?.vatRate) throw new HttpError(409, 'VAT_NOT_SET', 'Set the merchant VAT rate before redeeming partner vouchers');
  try {
    return calculateRedemption({ grossInvoiceAmount: grossAmount, vatRate: fromDecimal128(tenant.vatRate), rule: snapshotRule(voucher.ruleSnapshot) });
  } catch (error) {
    throw moneyToHttp(error);
  }
}

/**
 * "2026-10-31" -> the last millisecond of that day in Vietnam (UTC+7, no daylight saving).
 * @param {string} value
 */
export function endOfVietnamDay(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const start = Date.UTC(y, m - 1, d);
  if (new Date(start).getUTCDate() !== d) return null;
  return new Date(start + DAY_MS - 1 - VN_OFFSET_MS);
}

function newCode() {
  let code = '';
  for (let i = 0; i < VOUCHER_CODE_LENGTH; i++) code += VOUCHER_CODE_ALPHABET[randomInt(VOUCHER_CODE_ALPHABET.length)];
  return code;
}

/** @param {number} count */
export function newCodes(count) {
  const codes = new Set();
  while (codes.size < count) codes.add(newCode());
  return [...codes];
}

/** @param {string} value */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Staff-side view. The public page uses publicView, which leaves out customer and staff data.
 * @param {any} voucher
 * @param {Date} now
 * @param {Map<string, string>} [merchantNames]
 * @param {Map<string, any>} [brands] for the voucher card and share image in the console
 */
function voucherView(voucher, now, merchantNames, brands) {
  return {
    code: voucher.code,
    merchantId: voucher.tenantId,
    merchantName: merchantNames?.get(voucher.tenantId) ?? null,
    brand: brands?.get(voucher.tenantId) ?? null,
    source: voucher.source,
    status: effectiveVoucherStatus(voucher.status, voucher.validUntil, now),
    discountType: voucher.discountType,
    discountValue: fromDecimal128(voucher.discountValue),
    minBillAmount: voucher.minBillAmount ? fromDecimal128(voucher.minBillAmount) : null,
    validUntil: voucher.validUntil.toISOString(),
    customerName: voucher.customerName ?? null,
    note: voucher.note ?? null,
    batchId: voucher.batchId ?? null,
    createdAt: voucher.createdAt.toISOString(),
    redemption: voucher.redemption
      ? {
          grossAmount: fromDecimal128(voucher.redemption.grossAmount),
          discountAmount: fromDecimal128(voucher.redemption.discountAmount),
          payableAmount: fromDecimal128(voucher.redemption.payableAmount),
          redeemedAt: voucher.redemption.redeemedAt.toISOString(),
        }
      : null,
    voidedAt: voucher.voidedAt ? voucher.voidedAt.toISOString() : null,
    voidReason: voucher.voidReason ?? null,
  };
}

/**
 * @param {any} voucher
 * @param {string} merchantName
 * @param {Date} now
 * @param {any} [brand] merchant logo and colour
 */
export function publicView(voucher, merchantName, now, brand = null) {
  return {
    code: voucher.code,
    merchantName,
    brand,
    status: effectiveVoucherStatus(voucher.status, voucher.validUntil, now),
    discountType: voucher.discountType,
    discountValue: fromDecimal128(voucher.discountValue),
    minBillAmount: voucher.minBillAmount ? fromDecimal128(voucher.minBillAmount) : null,
    validUntil: voucher.validUntil.toISOString(),
  };
}

/**
 * @param {string} status
 * @param {Date} now
 */
function statusFilter(status, now) {
  if (status === 'ACTIVE') return { status: 'ACTIVE', validUntil: { $gt: now } };
  if (status === 'EXPIRED') return { $or: [{ status: 'EXPIRED' }, { status: 'ACTIVE', validUntil: { $lte: now } }] };
  return { status };
}

/**
 * Issues one voucher or a batch with the same terms. Codes are random; a clash on the unique
 * index (1 in ~10^12 per code) retries the whole batch with new codes.
 * @type {import('../http/router.js').Handler}
 */
async function issueVouchers(req, res, ctx) {
  const session = sessionOf(ctx);
  const body = await readJson(req);
  const discountType = stringField(body, 'discountType', { max: 16 });
  let discountValue;
  let minBillAmount = null;
  try {
    discountValue = parseDirectDiscount(discountType, body.discountValue);
    if (body.minBillAmount !== undefined && body.minBillAmount !== null && body.minBillAmount !== '') {
      minBillAmount = parseDecimal(body.minBillAmount, 'minBillAmount').toFixed(4);
    }
  } catch (error) {
    throw moneyToHttp(error);
  }
  const validUntil = endOfVietnamDay(stringField(body, 'validUntil', { max: 10 }));
  const now = new Date();
  if (!validUntil || validUntil <= now || validUntil.getTime() > now.getTime() + MAX_VALIDITY_DAYS * DAY_MS) {
    throw new HttpError(422, 'VALIDATION', 'validUntil must be a date from today up to one year ahead', { details: { field: 'validUntil' } });
  }
  const quantity = body.quantity === undefined ? 1 : body.quantity;
  if (!Number.isInteger(quantity) || /** @type {number} */ (quantity) < 1 || /** @type {number} */ (quantity) > VOUCHER_BATCH_MAX) {
    throw new HttpError(422, 'VALIDATION', `quantity must be 1 to ${VOUCHER_BATCH_MAX}`, { details: { field: 'quantity' } });
  }
  const count = /** @type {number} */ (quantity);
  const customerName = stringField(body, 'customerName', { max: 120, optional: true }).trim() || null;
  const note = stringField(body, 'note', { max: 500, optional: true }).trim() || null;
  const tenantId = /** @type {string} */ (session.tenantId);
  const batchId = count > 1 ? randomUUID() : null;

  for (let attempt = 1; ; attempt++) {
    const docs = newCodes(count).map((code) => ({
      _id: randomUUID(),
      tenantId,
      code,
      source: 'DIRECT',
      status: 'ACTIVE',
      discountType,
      discountValue: toDecimal128(discountValue),
      minBillAmount: minBillAmount ? toDecimal128(minBillAmount) : null,
      validUntil,
      customerName,
      note,
      batchId,
      createdBy: session.userId,
      createdAt: now,
      redemption: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
    }));
    try {
      await withTransaction(async (tx) => {
        const vouchers = await collection('vouchers');
        await vouchers.insertMany(docs, { session: tx });
        await recordAudit(
          {
            ...actorOf(ctx),
            eventType: 'VOUCHER_ISSUED',
            entityType: batchId ? 'voucher_batch' : 'voucher',
            entityId: batchId ?? docs[0]._id,
            after: { count, discountType, discountValue, minBillAmount, validUntil: validUntil.toISOString() },
          },
          { session: tx },
        );
      });
      const names = await merchantNames([tenantId]);
      const brands = await merchantBrands([tenantId]);
      sendJson(res, 201, { batchId, vouchers: docs.map((doc) => voucherView(doc, now, names, brands)) });
      return;
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 11000 || attempt >= 3) throw error;
    }
  }
}

/** @type {import('../http/router.js').Handler} */
async function listVouchers(req, res, ctx) {
  const session = sessionOf(ctx);
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const now = new Date();
  const scope = scopeFilter(session, params.get('merchantId'));

  /** @type {import('mongodb').Filter<any>[]} */
  const filters = [scope];
  const status = params.get('status');
  if (status) {
    if (!STATUS_FILTERS.includes(status)) throw new HttpError(422, 'VALIDATION', 'status is invalid', { details: { field: 'status' } });
    filters.push(statusFilter(status, now));
  }
  const batchId = params.get('batchId');
  if (batchId) {
    if (!UUID_PATTERN.test(batchId)) throw new HttpError(422, 'VALIDATION', 'batchId is invalid', { details: { field: 'batchId' } });
    filters.push({ batchId: batchId.toLowerCase() });
  }
  const q = (params.get('q') ?? '').trim().slice(0, 60);
  if (q) {
    const codePrefix = q.toUpperCase().replace(/[\s-]/g, '');
    filters.push({
      $or: [
        ...(/^[A-Z0-9]+$/.test(codePrefix) ? [{ code: { $regex: `^${escapeRegex(codePrefix)}` } }] : []),
        { customerName: { $regex: escapeRegex(q), $options: 'i' } },
      ],
    });
  }

  const vouchers = await collection('vouchers');
  const rows = await vouchers.find({ $and: filters }, { sort: { createdAt: -1 }, limit: LIST_LIMIT }).toArray();
  const countRows = await vouchers
    .aggregate([
      { $match: scope },
      {
        $group: {
          _id: { $cond: [{ $and: [{ $eq: ['$status', 'ACTIVE'] }, { $lte: ['$validUntil', now] }] }, 'EXPIRED', '$status'] },
          n: { $sum: 1 },
        },
      },
    ])
    .toArray();
  const counts = Object.fromEntries(STATUS_FILTERS.map((key) => [key, 0]));
  for (const row of countRows) counts[row._id] = row.n;
  const names = await merchantNames(rows.map((row) => row.tenantId));
  const brands = await merchantBrands(rows.map((row) => row.tenantId));
  sendJson(res, 200, { vouchers: rows.map((row) => voucherView(row, now, names, brands)), counts, limit: LIST_LIMIT });
}

/** @type {import('../http/router.js').Handler} */
async function voidVoucher(req, res, ctx) {
  const session = sessionOf(ctx);
  const code = parseVoucherCode(ctx.params.code);
  if (!code) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
  const reason = stringField(await readJson(req), 'reason', { max: 300 }).trim();
  if (!reason) throw new HttpError(422, 'VALIDATION', 'reason is required', { details: { field: 'reason' } });

  const voucher = await withTransaction(async (tx) => {
    const vouchers = await collection('vouchers');
    const now = new Date();
    const updated = await vouchers.findOneAndUpdate(
      { code, tenantId: session.tenantId, status: 'ACTIVE' },
      { $set: { status: 'VOID', voidedAt: now, voidedBy: session.userId, voidReason: reason } },
      { session: tx, returnDocument: 'after' },
    );
    if (!updated) {
      const exists = await vouchers.countDocuments({ code, tenantId: session.tenantId }, { session: tx, limit: 1 });
      if (!exists) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
      throw new HttpError(409, 'VOUCHER_NOT_ACTIVE', 'Only an active voucher can be voided');
    }
    await recordAudit(
      { ...actorOf(ctx), eventType: 'VOUCHER_VOIDED', entityType: 'voucher', entityId: updated._id, before: { status: 'ACTIVE' }, after: { status: 'VOID' }, reason },
      { session: tx },
    );
    return updated;
  });

  sendJson(res, 200, { voucher: voucherView(voucher, new Date(), await merchantNames([voucher.tenantId])) });
}

/**
 * Anyone holding the code (customer, counter before sign-in). No customer name, note or staff data.
 * `canRedeem` tells a signed-in counter role of the same merchant to show the redeem form.
 * @type {import('../http/router.js').Handler}
 */
async function publicVoucher(req, res, ctx) {
  await consume(`voucher-public:${clientIp(req)}`, RATE_LIMITS.publicVoucherIp);
  const code = parseVoucherCode(ctx.params.code);
  const vouchers = await collection('vouchers');
  const voucher = code ? await vouchers.findOne({ code }) : null;
  const names = voucher ? await merchantNames([voucher.tenantId]) : new Map();
  if (!voucher || !names.has(voucher.tenantId)) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
  const session = await loadSession(req);
  const canRedeem = Boolean(session && can(session.role, 'redemption.create') && session.tenantId === voucher.tenantId);
  const brand = (await merchantBrands([voucher.tenantId])).get(voucher.tenantId);
  sendJson(res, 200, { voucher: publicView(voucher, /** @type {string} */ (names.get(voucher.tenantId)), new Date(), brand), canRedeem });
}

/**
 * Counter lookup after a scan: the full voucher, only inside the signed-in merchant.
 * @type {import('../http/router.js').Handler}
 */
async function counterVoucher(_req, res, ctx) {
  const session = sessionOf(ctx);
  const code = parseVoucherCode(ctx.params.code);
  const vouchers = await collection('vouchers');
  const voucher = code ? await vouchers.findOne({ code, tenantId: session.tenantId }) : null;
  if (!voucher) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
  sendJson(res, 200, { voucher: voucherView(voucher, new Date(), await merchantNames([voucher.tenantId])) });
}

/**
 * @param {string} status effective status
 * @param {any} voucher
 */
function notRedeemable(status, voucher) {
  if (status === 'REDEEMED') {
    return new HttpError(409, 'VOUCHER_ALREADY_REDEEMED', 'This voucher was already redeemed', {
      details: { redeemedAt: voucher.redemption?.redeemedAt?.toISOString() ?? null },
    });
  }
  if (status === 'EXPIRED') return new HttpError(409, 'VOUCHER_EXPIRED', 'This voucher has expired');
  return new HttpError(409, 'VOUCHER_VOID', 'This voucher was voided');
}

/**
 * Redeems once. The conditional update on status ACTIVE inside a transaction means two counters
 * confirming at the same time get one success and one 409 (VCH-04).
 * @type {import('../http/router.js').Handler}
 */
async function redeemVoucher(req, res, ctx) {
  const session = sessionOf(ctx);
  const code = parseVoucherCode(ctx.params.code);
  if (!code) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
  const body = await readJson(req);

  const redeemed = await withTransaction(async (tx) => {
    const now = new Date();
    const vouchers = await collection('vouchers');
    const voucher = await vouchers.findOne({ code, tenantId: session.tenantId }, { session: tx });
    if (!voucher) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
    const status = effectiveVoucherStatus(voucher.status, voucher.validUntil, now);
    if (status !== 'ACTIVE') throw notRedeemable(status, voucher);

    const redemptionId = randomUUID();
    let amounts;
    /** @type {Record<string, unknown>} */
    let extra = {};
    /** @type {import('#domain').RedemptionAmounts['commissionItems']} */
    let commissionItems = [];
    if (voucher.source === 'REFERRAL') {
      const referral = await referralAmounts(voucher, body.grossAmount, tx);
      amounts = { grossAmount: referral.grossInvoiceAmount, discountAmount: referral.customerDiscountAmount, payableAmount: referral.discountedGrossPayable };
      extra = {
        vatRate: toDecimal128(referral.vatRate),
        netNetCommissionBase: toDecimal128(referral.netNetCommissionBase),
        vatAmount: toDecimal128(referral.vatAmount),
      };
      commissionItems = referral.commissionItems;
    } else {
      try {
        amounts = calculateDirectRedemption({
          discountType: voucher.discountType,
          discountValue: fromDecimal128(voucher.discountValue),
          minBillAmount: voucher.minBillAmount ? fromDecimal128(voucher.minBillAmount) : null,
          grossAmount: body.grossAmount,
        });
      } catch (error) {
        throw moneyToHttp(error);
      }
    }
    const redemption = {
      id: redemptionId,
      grossAmount: toDecimal128(amounts.grossAmount),
      discountAmount: toDecimal128(amounts.discountAmount),
      payableAmount: toDecimal128(amounts.payableAmount),
      ...extra,
      redeemedBy: session.userId,
      roleAssignmentId: session.roleAssignmentId,
      redeemedAt: now,
    };
    const result = await vouchers.updateOne(
      { _id: voucher._id, status: 'ACTIVE', validUntil: { $gt: now } },
      { $set: { status: 'REDEEMED', redemption } },
      { session: tx },
    );
    if (result.modifiedCount !== 1) throw notRedeemable('REDEEMED', voucher);
    if (commissionItems.length) {
      const items = await collection('commissionItems');
      await items.insertMany(
        commissionItems.map((item) => ({
          _id: randomUUID(),
          tenantId: voucher.tenantId,
          voucherId: voucher._id,
          redemptionId,
          partnerId: voucher.partnerId,
          mediumId: voucher.mediumId ?? null,
          ruleId: voucher.ruleSnapshot.ruleId ?? null,
          ruleVersion: voucher.ruleSnapshot.version ?? null,
          obligationType: item.obligationType,
          rate: toDecimal128(item.rate),
          baseAmount: toDecimal128(item.baseAmount),
          amount: toDecimal128(item.amount),
          status: 'OPEN',
          redeemedAt: now,
          createdAt: now,
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
        })),
        { session: tx },
      );
    }
    await recordAudit(
      {
        ...actorOf(ctx),
        eventType: 'VOUCHER_REDEEMED',
        entityType: 'voucher',
        entityId: voucher._id,
        before: { status: 'ACTIVE' },
        after: { ...amounts, redemptionId, commissionItems },
      },
      { session: tx },
    );
    return { ...voucher, status: 'REDEEMED', redemption };
  });

  sendJson(res, 200, { voucher: voucherView(redeemed, new Date(), await merchantNames([redeemed.tenantId])) });
}

/**
 * Undo a redemption entered by mistake (plan J09): the voucher is usable again until its end date and
 * its commission items are voided. Refused once any item is paid. The voided redemption stays on file.
 * @type {import('../http/router.js').Handler}
 */
async function voidRedemption(req, res, ctx) {
  const session = sessionOf(ctx);
  const code = parseVoucherCode(ctx.params.code);
  if (!code) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
  const reason = stringField(await readJson(req), 'reason', { max: 300 }).trim();
  if (!reason) throw new HttpError(422, 'VALIDATION', 'reason is required', { details: { field: 'reason' } });

  const voucher = await withTransaction(async (tx) => {
    const now = new Date();
    const vouchers = await collection('vouchers');
    const found = await vouchers.findOne({ code, tenantId: session.tenantId }, { session: tx });
    if (!found) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
    if (found.status !== 'REDEEMED' || !found.redemption) throw new HttpError(409, 'VOUCHER_NOT_REDEEMED', 'This voucher has no redemption to void');
    const items = await collection('commissionItems');
    const redemptionId = found.redemption.id ?? null;
    if (redemptionId && (await items.countDocuments({ redemptionId, status: 'PAID' }, { session: tx, limit: 1 }))) {
      throw new HttpError(409, 'COMMISSION_PAID', 'The commission of this redemption is already paid');
    }
    const status = found.validUntil > now ? 'ACTIVE' : 'EXPIRED';
    const voided = { ...found.redemption, voidedAt: now, voidedBy: session.userId, voidReason: reason };
    const result = await vouchers.updateOne(
      { _id: found._id, status: 'REDEEMED' },
      { $set: { status, redemption: null }, $push: { voidedRedemptions: voided } },
      { session: tx },
    );
    if (result.modifiedCount !== 1) throw new HttpError(409, 'VOUCHER_NOT_REDEEMED', 'This voucher has no redemption to void');
    const voidedItems = redemptionId
      ? await items.updateMany(
          { redemptionId, status: 'OPEN' },
          { $set: { status: 'VOID', voidedAt: now, voidedBy: session.userId, voidReason: reason } },
          { session: tx },
        )
      : { modifiedCount: 0 };
    await recordAudit(
      {
        ...actorOf(ctx),
        eventType: 'REDEMPTION_VOIDED',
        entityType: 'voucher',
        entityId: found._id,
        before: { status: 'REDEEMED', redemptionId },
        after: { status, commissionItemsVoided: voidedItems.modifiedCount },
        reason,
      },
      { session: tx },
    );
    return { ...found, status, redemption: null };
  });

  sendJson(res, 200, { voucher: voucherView(voucher, new Date(), await merchantNames([voucher.tenantId])) });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const voucherRoutes = [
  { method: 'GET', path: '/api/v1/vouchers', handler: authed(listVouchers, { permission: 'voucher.list' }) },
  { method: 'POST', path: '/api/v1/vouchers', handler: authed(issueVouchers, { permission: 'voucher.issue' }) },
  { method: 'POST', path: '/api/v1/vouchers/:code/void', handler: authed(voidVoucher, { permission: 'voucher.void' }) },
  { method: 'GET', path: '/api/v1/vouchers/:code', handler: authed(counterVoucher, { permission: 'voucher.validate' }) },
  { method: 'POST', path: '/api/v1/vouchers/:code/redeem', handler: authed(redeemVoucher, { permission: 'redemption.create' }) },
  { method: 'POST', path: '/api/v1/vouchers/:code/void-redemption', handler: authed(voidRedemption, { permission: 'redemption.void' }) },
  { method: 'GET', path: '/api/v1/public/vouchers/:code', handler: publicVoucher },
];
