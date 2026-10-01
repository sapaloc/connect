import { fromDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';

/** Items the merchant owes the partner itself (a company's share to its own referrers is not included). */
export const MERCHANT_PAYS = ['TENANT_TO_COMPANY', 'TENANT_TO_INDEPENDENT_INDIVIDUAL'];

/**
 * @typedef {{
 *   opens: number, activations: number, redemptions: number,
 *   commissionOpen?: string, commissionPaid?: string, commissionPending?: string, pendingReviews?: number, lastPaidAt?: string | null,
 * }} PartnerStats
 */

/** @param {any} payout stored commission payout */
export function payoutView(payout) {
  return { id: payout._id, amount: fromDecimal128(payout.amount), itemCount: payout.itemCount, note: payout.note ?? null, paidAt: payout.paidAt.toISOString() };
}

/**
 * Event counts per partner (plan J11: link opens, voucher activations, redemptions; never "customers").
 * Commission unpaid / paid = sums of OPEN / PAID items, exact to 4 decimals; only when `withCommission`.
 * @param {string[]} partnerIds
 * @param {{ withCommission: boolean }} options
 * @returns {Promise<Map<string, PartnerStats>>}
 */
export async function partnerStats(partnerIds, { withCommission }) {
  /** @type {Map<string, PartnerStats>} */
  const stats = new Map(
    partnerIds.map((id) => [
      id,
      {
        opens: 0,
        activations: 0,
        redemptions: 0,
        ...(withCommission ? { commissionOpen: '0.0000', commissionPaid: '0.0000', commissionPending: '0.0000', pendingReviews: 0, lastPaidAt: null } : {}),
      },
    ]),
  );
  if (!partnerIds.length) return stats;
  const match = { partnerId: { $in: partnerIds } };

  const visits = await collection('referralVisits');
  for (const row of await visits.aggregate([{ $match: { ...match, result: 'VALID' } }, { $group: { _id: '$partnerId', n: { $sum: 1 } } }]).toArray()) {
    /** @type {PartnerStats} */ (stats.get(row._id)).opens = row.n;
  }

  const vouchers = await collection('vouchers');
  const voucherRows = await vouchers
    .aggregate([
      { $match: { ...match, source: 'REFERRAL' } },
      { $group: { _id: '$partnerId', activations: { $sum: 1 }, redemptions: { $sum: { $cond: [{ $eq: ['$status', 'REDEEMED'] }, 1, 0] } } } },
    ])
    .toArray();
  for (const row of voucherRows) Object.assign(/** @type {PartnerStats} */ (stats.get(row._id)), { activations: row.activations, redemptions: row.redemptions });

  if (withCommission) {
    const items = await collection('commissionItems');
    const sums = await items
      .aggregate([
        { $match: { ...match, status: { $in: ['OPEN', 'PAID'] }, obligationType: { $in: MERCHANT_PAYS } } },
        { $group: { _id: { partnerId: '$partnerId', status: '$status' }, amount: { $sum: '$amount' } } },
      ])
      .toArray();
    for (const row of sums) {
      const entry = /** @type {PartnerStats} */ (stats.get(row._id.partnerId));
      if (row._id.status === 'OPEN') entry.commissionOpen = fromDecimal128(row.amount);
      else entry.commissionPaid = fromDecimal128(row.amount);
    }
    const reviews = await collection('commissionReviews');
    const pending = await reviews
      .aggregate([{ $match: { ...match, status: 'PENDING' } }, { $group: { _id: '$partnerId', amount: { $sum: '$amount' }, n: { $sum: 1 } } }])
      .toArray();
    for (const row of pending) {
      Object.assign(/** @type {PartnerStats} */ (stats.get(row._id)), { commissionPending: fromDecimal128(row.amount), pendingReviews: row.n });
    }
    const payouts = await collection('commissionPayouts');
    for (const row of await payouts.aggregate([{ $match: match }, { $group: { _id: '$partnerId', last: { $max: '$paidAt' } } }]).toArray()) {
      /** @type {PartnerStats} */ (stats.get(row._id)).lastPaidAt = row.last.toISOString();
    }
  }
  return stats;
}
