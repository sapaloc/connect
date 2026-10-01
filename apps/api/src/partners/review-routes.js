import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { fromDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { merchantNames, UUID_PATTERN } from '../merchants/scope.js';
import { commissionDocs, voucherView } from '../vouchers/voucher-routes.js';

const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
const LIST_LIMIT = 100;

/** @param {import('../http/router.js').Context} ctx */
function sessionOf(ctx) {
  return /** @type {import('../auth/session.js').Session} */ (ctx.session);
}

/** @param {string} id */
function reviewId(id) {
  const value = String(id ?? '').toLowerCase();
  if (!UUID_PATTERN.test(value)) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review not found');
  return value;
}

/** @param {any} review @param {any} voucher @param {Map<string, string>} names @param {Date} now */
function reviewView(review, voucher, names, now) {
  return {
    id: review._id,
    partnerId: review.partnerId,
    status: review.status,
    reason: review.reason,
    amount: fromDecimal128(review.amount),
    createdAt: review.createdAt.toISOString(),
    reviewedAt: review.reviewedAt ? review.reviewedAt.toISOString() : null,
    reviewNote: review.reviewNote ?? null,
    voucher: voucher ? voucherView(voucher, now, names) : null,
  };
}

/**
 * Redemptions recorded without the guest's confirmation, for the Merchant admin to check against
 * the bill photo.
 * @type {import('../http/router.js').Handler}
 */
async function listReviews(req, res, ctx) {
  const session = sessionOf(ctx);
  const url = new URL(req.url ?? '/', 'http://localhost');
  /** @type {Record<string, unknown>} */
  const filter = { tenantId: session.tenantId };
  const partnerId = url.searchParams.get('partnerId');
  if (partnerId) {
    if (!UUID_PATTERN.test(partnerId)) throw new HttpError(422, 'VALIDATION', 'partnerId is invalid', { details: { field: 'partnerId' } });
    filter.partnerId = partnerId.toLowerCase();
  }
  const status = url.searchParams.get('status') ?? 'PENDING';
  if (!REVIEW_STATUSES.includes(status)) throw new HttpError(422, 'VALIDATION', 'status is invalid', { details: { field: 'status' } });
  filter.status = status;

  const reviews = await collection('commissionReviews');
  const rows = await reviews.find(filter).sort({ createdAt: -1 }).limit(LIST_LIMIT).toArray();
  const vouchers = await collection('vouchers');
  const byId = new Map((await vouchers.find({ _id: { $in: rows.map((row) => row.voucherId) } }).toArray()).map((v) => [v._id, v]));
  const names = await merchantNames([session.tenantId]);
  const now = new Date();
  sendJson(res, 200, { reviews: rows.map((row) => reviewView(row, byId.get(row.voucherId), names, now)) });
}

/**
 * @param {'APPROVED' | 'REJECTED'} decision
 * @returns {import('../http/router.js').Handler}
 */
function decide(decision) {
  return async (req, res, ctx) => {
    const session = sessionOf(ctx);
    const id = reviewId(ctx.params.id);
    const body = await readJson(req);
    const note = stringField(body, 'note', { max: 500, optional: true }) || null;
    if (decision === 'REJECTED' && !note) throw new HttpError(422, 'VALIDATION', 'note is required', { details: { field: 'note' } });

    const result = await withTransaction(async (tx) => {
      const now = new Date();
      const reviews = await collection('commissionReviews');
      const review = await reviews.findOneAndUpdate(
        { _id: id, tenantId: session.tenantId, status: 'PENDING' },
        { $set: { status: decision, reviewedBy: session.userId, reviewedAt: now, reviewNote: note } },
        { returnDocument: 'after', session: tx },
      );
      if (!review) {
        const found = await reviews.findOne({ _id: id, tenantId: session.tenantId }, { session: tx });
        if (!found) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review not found');
        throw new HttpError(409, 'REVIEW_NOT_PENDING', 'This review is already decided', { details: { status: found.status } });
      }
      const vouchers = await collection('vouchers');
      const voucher = await vouchers.findOne({ _id: review.voucherId }, { session: tx });
      if (decision === 'APPROVED') {
        if (voucher?.status !== 'REDEEMED' || voucher.redemption?.id !== review.redemptionId) {
          throw new HttpError(409, 'REVIEW_NOT_PENDING', 'This redemption was voided', { details: { status: 'CANCELLED' } });
        }
        const items = review.items.map((/** @type {any} */ item) => ({
          obligationType: item.obligationType,
          rate: fromDecimal128(item.rate),
          baseAmount: fromDecimal128(item.baseAmount),
          amount: fromDecimal128(item.amount),
        }));
        const docs = commissionDocs(voucher, review.redemptionId, items, voucher.redemption.redeemedAt, now);
        if (docs.length) await (await collection('commissionItems')).insertMany(docs, { session: tx });
      }
      await recordAudit(
        {
          ...actorOf(ctx),
          eventType: decision === 'APPROVED' ? 'COMMISSION_REVIEW_APPROVED' : 'COMMISSION_REVIEW_REJECTED',
          entityType: 'commission_review',
          entityId: review._id,
          before: { status: 'PENDING' },
          after: { status: decision, amount: fromDecimal128(review.amount) },
          reason: note,
        },
        { session: tx },
      );
      return { review, voucher };
    });

    const names = await merchantNames([session.tenantId]);
    sendJson(res, 200, { review: reviewView(result.review, result.voucher, names, new Date()) });
  };
}

/** @type {import('../http/router.js').RouteDef[]} */
export const reviewRoutes = [
  { method: 'GET', path: '/api/v1/commission-reviews', handler: authed(listReviews, { permission: 'commission.review' }) },
  { method: 'POST', path: '/api/v1/commission-reviews/:id/approve', handler: authed(decide('APPROVED'), { permission: 'commission.review' }) },
  { method: 'POST', path: '/api/v1/commission-reviews/:id/reject', handler: authed(decide('REJECTED'), { permission: 'commission.review' }) },
];
