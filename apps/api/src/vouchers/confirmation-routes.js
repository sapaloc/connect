import {
  CONFIRMATION_STATUSES,
  effectiveConfirmationStatus,
  effectiveVoucherStatus,
  FALLBACK_REASONS,
  GUEST_CONFIRMATION_MINUTES,
  parseVoucherCode,
  sumAmounts,
} from '#domain';
import { randomUUID } from 'node:crypto';
import { actorOf, recordAudit } from '../audit/audit.js';
import { authed } from '../auth/guard.js';
import { consume } from '../auth/rate-limit.js';
import { RATE_LIMITS } from '../config/security.js';
import { fromDecimal128, toDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../http/errors.js';
import { clientIp, readJson, stringField } from '../http/request.js';
import { sendJson } from '../http/respond.js';
import { merchantBrands, merchantNames, UUID_PATTERN } from '../merchants/scope.js';
import { MERCHANT_PAYS } from '../partners/stats.js';
import { browserIdOf, isMerchantBrowser } from '../referrals/referral-routes.js';
import { applyRedemption, notRedeemable, publicView, referralAmounts, voucherView } from './voucher-routes.js';

const MINUTE_MS = 60 * 1000;
const { PENDING, CONFIRMED, DECLINED, EXPIRED, CANCELLED, FALLBACK } = CONFIRMATION_STATUSES;

/** @param {import('../http/router.js').Context} ctx */
function sessionOf(ctx) {
  return /** @type {import('../auth/session.js').Session} */ (ctx.session);
}

/** @param {string} id */
function confirmationId(id) {
  const value = String(id ?? '').toLowerCase();
  if (!UUID_PATTERN.test(value)) throw new HttpError(404, 'CONFIRMATION_NOT_FOUND', 'Confirmation not found');
  return value;
}

/** @param {any} confirmation @param {Date} now */
function amountsView(confirmation, now) {
  return {
    id: confirmation._id,
    status: effectiveConfirmationStatus(confirmation.status, confirmation.expiresAt, now),
    grossAmount: fromDecimal128(confirmation.grossAmount),
    discountAmount: fromDecimal128(confirmation.discountAmount),
    payableAmount: fromDecimal128(confirmation.payableAmount),
    expiresAt: confirmation.expiresAt.toISOString(),
  };
}

/**
 * Counter view. The confirm path is what the Counter shows as a QR for a guest holding only an image.
 * @param {any} confirmation
 * @param {Date} now
 * @param {any} [voucher] the redeemed voucher, once confirmed or recorded without confirmation
 */
async function staffView(confirmation, now, voucher = null) {
  return {
    ...amountsView(confirmation, now),
    code: confirmation.code,
    confirmPath: `/v/${confirmation.code}?confirm=${confirmation._id}`,
    fallbackReason: confirmation.fallbackReason ?? null,
    voucher: voucher ? voucherView(voucher, now, await merchantNames([voucher.tenantId])) : null,
  };
}

/** @param {any} confirmation */
function notPending(confirmation) {
  return new HttpError(409, 'CONFIRMATION_NOT_PENDING', 'This confirmation is no longer waiting', {
    details: { status: effectiveConfirmationStatus(confirmation.status, confirmation.expiresAt) },
  });
}

/**
 * Counter asks the guest to confirm the bill of a partner voucher. Amounts are computed and locked
 * now; a request still waiting for this voucher is replaced, so a corrected bill means a new request.
 * @type {import('../http/router.js').Handler}
 */
async function requestConfirmation(req, res, ctx) {
  const session = sessionOf(ctx);
  const code = parseVoucherCode(ctx.params.code);
  if (!code) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
  const body = await readJson(req);

  const confirmation = await withTransaction(async (tx) => {
    const now = new Date();
    const vouchers = await collection('vouchers');
    const voucher = await vouchers.findOne({ code, tenantId: session.tenantId }, { session: tx });
    if (!voucher) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
    const status = effectiveVoucherStatus(voucher.status, voucher.validUntil, now);
    if (status !== 'ACTIVE') throw notRedeemable(status, voucher);
    if (voucher.source !== 'REFERRAL') throw new HttpError(409, 'CONFIRMATION_NOT_NEEDED', 'Only a partner voucher needs the guest to confirm');
    const { commissionItems: _items, ...amounts } = referralAmounts(voucher, body.grossAmount);

    const confirmations = await collection('redemptionConfirmations');
    await confirmations.updateMany(
      { voucherId: voucher._id, status: PENDING },
      [{ $set: { status: { $cond: [{ $lte: ['$expiresAt', now] }, EXPIRED, CANCELLED] }, resolvedAt: now } }],
      { session: tx },
    );
    const doc = {
      _id: randomUUID(),
      tenantId: voucher.tenantId,
      voucherId: voucher._id,
      code: voucher.code,
      browserContextId: voucher.browserContextId,
      grossAmount: toDecimal128(amounts.grossAmount),
      discountAmount: toDecimal128(amounts.discountAmount),
      payableAmount: toDecimal128(amounts.payableAmount),
      status: PENDING,
      requestedBy: session.userId,
      roleAssignmentId: session.roleAssignmentId ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + GUEST_CONFIRMATION_MINUTES * MINUTE_MS),
      resolvedAt: null,
      redemptionId: null,
      fallbackReason: null,
    };
    try {
      await confirmations.insertOne(doc, { session: tx });
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 11000) throw new HttpError(409, 'CONFIRMATION_PENDING', 'Another confirmation for this voucher was just sent');
      throw error;
    }
    await recordAudit(
      { ...actorOf(ctx), eventType: 'CONFIRMATION_REQUESTED', entityType: 'voucher', entityId: voucher._id, after: { confirmationId: doc._id, ...amounts } },
      { session: tx },
    );
    return doc;
  });

  sendJson(res, 201, { confirmation: await staffView(confirmation, new Date()) });
}

/** @type {import('../http/router.js').Handler} */
async function readConfirmation(_req, res, ctx) {
  const session = sessionOf(ctx);
  const confirmations = await collection('redemptionConfirmations');
  const confirmation = await confirmations.findOne({ _id: confirmationId(ctx.params.id), tenantId: session.tenantId });
  if (!confirmation) throw new HttpError(404, 'CONFIRMATION_NOT_FOUND', 'Confirmation not found');
  const done = confirmation.status === CONFIRMED || confirmation.status === FALLBACK;
  const voucher = done ? await (await collection('vouchers')).findOne({ _id: confirmation.voucherId }) : null;
  sendJson(res, 200, { confirmation: await staffView(confirmation, new Date(), voucher) });
}

/** @type {import('../http/router.js').Handler} */
async function cancelConfirmation(_req, res, ctx) {
  const session = sessionOf(ctx);
  const id = confirmationId(ctx.params.id);
  const confirmations = await collection('redemptionConfirmations');
  const now = new Date();
  const updated = await confirmations.findOneAndUpdate(
    { _id: id, tenantId: session.tenantId, status: PENDING },
    { $set: { status: CANCELLED, resolvedAt: now } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    const found = await confirmations.findOne({ _id: id, tenantId: session.tenantId });
    if (!found) throw new HttpError(404, 'CONFIRMATION_NOT_FOUND', 'Confirmation not found');
    throw notPending(found);
  }
  sendJson(res, 200, { confirmation: await staffView(updated, now) });
}

/**
 * The guest could not confirm (other phone, voucher passed on, no internet, no answer): staff record
 * the redemption with a bill photo and a reason. The guest gets the discount; the commission waits in
 * a review for the Merchant admin instead of becoming unpaid.
 * @type {import('../http/router.js').Handler}
 */
async function recordWithoutConfirmation(req, res, ctx) {
  const session = sessionOf(ctx);
  const id = confirmationId(ctx.params.id);
  const reason = stringField(await readJson(req), 'reason', { max: 32 });
  if (!FALLBACK_REASONS.includes(reason)) throw new HttpError(422, 'VALIDATION', 'reason is invalid', { details: { field: 'reason' } });

  const result = await withTransaction(async (tx) => {
    const now = new Date();
    const confirmations = await collection('redemptionConfirmations');
    const confirmation = await confirmations.findOne({ _id: id, tenantId: session.tenantId }, { session: tx });
    if (!confirmation) throw new HttpError(404, 'CONFIRMATION_NOT_FOUND', 'Confirmation not found');
    const status = effectiveConfirmationStatus(confirmation.status, confirmation.expiresAt, now);
    if (status !== PENDING && status !== EXPIRED) throw notPending(confirmation);

    const vouchers = await collection('vouchers');
    const voucher = await vouchers.findOne({ _id: confirmation.voucherId }, { session: tx });
    const voucherStatus = effectiveVoucherStatus(voucher.status, voucher.validUntil, now);
    if (voucherStatus !== 'ACTIVE') throw notRedeemable(voucherStatus, voucher);
    const photo = (voucher.billPhotos ?? []).some(
      (/** @type {any} */ p) => p.addedBy === 'STAFF' && p.addedAt >= confirmation.createdAt,
    );
    if (!photo) throw new HttpError(422, 'BILL_PHOTO_REQUIRED', 'Add a photo of the bill first', { details: { field: 'billPhoto' } });

    const { commissionItems, ...amounts } = referralAmounts(voucher, fromDecimal128(confirmation.grossAmount));
    const done = await applyRedemption(tx, {
      voucher,
      amounts,
      commissionItems: [],
      redeemedBy: session.userId,
      roleAssignmentId: session.roleAssignmentId ?? null,
      now,
      confirmation: { id: confirmation._id, method: 'UNCONFIRMED', at: now },
    });
    let reviewId = null;
    if (commissionItems.length) {
      reviewId = randomUUID();
      const reviews = await collection('commissionReviews');
      await reviews.insertOne(
        {
          _id: reviewId,
          tenantId: voucher.tenantId,
          voucherId: voucher._id,
          redemptionId: done.redemptionId,
          confirmationId: confirmation._id,
          partnerId: voucher.partnerId,
          items: commissionItems.map((item) => ({
            obligationType: item.obligationType,
            rate: toDecimal128(item.rate),
            baseAmount: toDecimal128(item.baseAmount),
            amount: toDecimal128(item.amount),
          })),
          amount: toDecimal128(sumAmounts(commissionItems.filter((item) => MERCHANT_PAYS.includes(item.obligationType)).map((item) => item.amount))),
          reason,
          requestedBy: session.userId,
          status: 'PENDING',
          createdAt: now,
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
        },
        { session: tx },
      );
    }
    await confirmations.updateOne(
      { _id: confirmation._id },
      { $set: { status: FALLBACK, resolvedAt: now, redemptionId: done.redemptionId, fallbackReason: reason } },
      { session: tx },
    );
    await recordAudit(
      {
        ...actorOf(ctx),
        eventType: 'VOUCHER_REDEEMED',
        entityType: 'voucher',
        entityId: voucher._id,
        before: { status: 'ACTIVE' },
        after: { ...amounts, redemptionId: done.redemptionId, confirmation: 'UNCONFIRMED', confirmationId: confirmation._id, reviewId, commissionItems },
        reason,
      },
      { session: tx },
    );
    return { confirmation: { ...confirmation, status: FALLBACK, fallbackReason: reason }, voucher: done.redeemed };
  });

  const now = new Date();
  sendJson(res, 200, { confirmation: await staffView(result.confirmation, now, result.voucher) });
}

/**
 * The guest browser behind a public request: the anonymous cookie must be the one that took the
 * voucher, and the browser must not be signed in to this merchant.
 * @param {import('node:http').IncomingMessage} req
 * @param {any} voucher
 */
async function isGuestOf(req, voucher) {
  const browserId = browserIdOf(req);
  if (voucher.source !== 'REFERRAL' || !browserId || browserId !== voucher.browserContextId) return false;
  return !(await isMerchantBrowser(req, voucher.tenantId));
}

/**
 * Guest voucher page polls this. Only the browser that took the voucher sees the waiting request;
 * any other browser gets `owner: false` and stops polling.
 * @type {import('../http/router.js').Handler}
 */
async function guestPending(req, res, ctx) {
  const browserId = browserIdOf(req);
  await consume(`confirmation-poll:${browserId ?? clientIp(req)}`, RATE_LIMITS.confirmationPollBrowser);
  await consume(`confirmation-poll-ip:${clientIp(req)}`, RATE_LIMITS.confirmationPollIp);
  const code = parseVoucherCode(ctx.params.code);
  const vouchers = await collection('vouchers');
  const voucher = code ? await vouchers.findOne({ code }) : null;
  if (!voucher) throw new HttpError(404, 'VOUCHER_NOT_FOUND', 'Voucher not found');
  const now = new Date();
  const voucherStatus = effectiveVoucherStatus(voucher.status, voucher.validUntil, now);
  if (!(await isGuestOf(req, voucher))) {
    sendJson(res, 200, { owner: false, voucherStatus, confirmation: null });
    return;
  }
  const confirmations = await collection('redemptionConfirmations');
  const pending = await confirmations.findOne({ voucherId: voucher._id, status: PENDING, expiresAt: { $gt: now } });
  sendJson(res, 200, { owner: true, voucherStatus, confirmation: pending ? amountsView(pending, now) : null });
}

/**
 * Loads a request for a guest answer and checks it is this guest's browser.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} id
 */
async function guestRequest(req, id) {
  await consume(`confirmation-answer:${clientIp(req)}`, RATE_LIMITS.confirmationAnswerIp);
  const confirmations = await collection('redemptionConfirmations');
  const confirmation = await confirmations.findOne({ _id: confirmationId(id) });
  if (!confirmation) throw new HttpError(404, 'CONFIRMATION_NOT_FOUND', 'Confirmation not found');
  if (browserIdOf(req) !== confirmation.browserContextId) {
    throw new HttpError(403, 'CONFIRMATION_WRONG_BROWSER', 'Open this on the phone that took the voucher');
  }
  if (await isMerchantBrowser(req, confirmation.tenantId)) {
    throw new HttpError(403, 'CONFIRMATION_MERCHANT_BROWSER', 'A merchant account cannot confirm for the guest');
  }
  return confirmation;
}

/**
 * Guest confirms: the redemption and its commission are recorded with the amounts locked by the
 * counter. Two taps at once: the conditional update lets one through, the other gets 409.
 * @type {import('../http/router.js').Handler}
 */
async function guestConfirm(req, res, ctx) {
  const confirmation = await guestRequest(req, ctx.params.id);
  const redeemed = await withTransaction(async (tx) => {
    const now = new Date();
    const confirmations = await collection('redemptionConfirmations');
    const claimed = await confirmations.updateOne(
      { _id: confirmation._id, status: PENDING, expiresAt: { $gt: now } },
      { $set: { status: CONFIRMED, resolvedAt: now } },
      { session: tx },
    );
    if (claimed.modifiedCount !== 1) {
      throw notPending((await confirmations.findOne({ _id: confirmation._id }, { session: tx })) ?? confirmation);
    }
    const vouchers = await collection('vouchers');
    const voucher = await vouchers.findOne({ _id: confirmation.voucherId }, { session: tx });
    const status = effectiveVoucherStatus(voucher.status, voucher.validUntil, now);
    if (status !== 'ACTIVE') throw notRedeemable(status, voucher);
    const { commissionItems, ...amounts } = referralAmounts(voucher, fromDecimal128(confirmation.grossAmount));
    const done = await applyRedemption(tx, {
      voucher,
      amounts,
      commissionItems,
      redeemedBy: confirmation.requestedBy,
      roleAssignmentId: confirmation.roleAssignmentId ?? null,
      now,
      confirmation: { id: confirmation._id, method: 'GUEST', at: now },
    });
    await confirmations.updateOne({ _id: confirmation._id }, { $set: { redemptionId: done.redemptionId } }, { session: tx });
    await recordAudit(
      {
        ...actorOf(ctx),
        tenantId: voucher.tenantId,
        eventType: 'VOUCHER_REDEEMED',
        entityType: 'voucher',
        entityId: voucher._id,
        before: { status: 'ACTIVE' },
        after: { ...amounts, redemptionId: done.redemptionId, confirmation: 'GUEST', confirmationId: confirmation._id, commissionItems },
      },
      { session: tx },
    );
    return done.redeemed;
  });
  const names = await merchantNames([redeemed.tenantId]);
  const brand = (await merchantBrands([redeemed.tenantId])).get(redeemed.tenantId);
  sendJson(res, 200, { voucher: publicView(redeemed, /** @type {string} */ (names.get(redeemed.tenantId)), new Date(), brand) });
}

/**
 * Guest says the amount is not right: nothing is recorded and the voucher stays usable.
 * @type {import('../http/router.js').Handler}
 */
async function guestDecline(req, res, ctx) {
  const confirmation = await guestRequest(req, ctx.params.id);
  const now = new Date();
  const confirmations = await collection('redemptionConfirmations');
  const updated = await confirmations.findOneAndUpdate(
    { _id: confirmation._id, status: PENDING, expiresAt: { $gt: now } },
    { $set: { status: DECLINED, resolvedAt: now } },
    { returnDocument: 'after' },
  );
  if (!updated) throw notPending((await confirmations.findOne({ _id: confirmation._id })) ?? confirmation);
  await recordAudit({
    ...actorOf(ctx),
    tenantId: confirmation.tenantId,
    eventType: 'CONFIRMATION_DECLINED',
    entityType: 'voucher',
    entityId: confirmation.voucherId,
    after: { confirmationId: confirmation._id },
  });
  sendJson(res, 200, { confirmation: amountsView(updated, now) });
}

/** @type {import('../http/router.js').RouteDef[]} */
export const confirmationRoutes = [
  { method: 'POST', path: '/api/v1/vouchers/:code/confirmations', handler: authed(requestConfirmation, { permission: 'redemption.create' }) },
  { method: 'GET', path: '/api/v1/confirmations/:id', handler: authed(readConfirmation, { permission: 'redemption.create' }) },
  { method: 'POST', path: '/api/v1/confirmations/:id/cancel', handler: authed(cancelConfirmation, { permission: 'redemption.create' }) },
  { method: 'POST', path: '/api/v1/confirmations/:id/fallback', handler: authed(recordWithoutConfirmation, { permission: 'redemption.create' }) },
  { method: 'GET', path: '/api/v1/public/vouchers/:code/confirmation', handler: guestPending },
  { method: 'POST', path: '/api/v1/public/confirmations/:id/confirm', handler: guestConfirm },
  { method: 'POST', path: '/api/v1/public/confirmations/:id/decline', handler: guestDecline },
];
