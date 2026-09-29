import { fromDecimal128 } from '../db/decimal.js';
import { collection } from '../db/mongo.js';

/** Items the merchant owes the partner itself (a company's share to its own referrers is not included). */
export const MERCHANT_PAYS = ['TENANT_TO_COMPANY', 'TENANT_TO_INDEPENDENT_INDIVIDUAL'];

/**
 * @typedef {{ opens: number, activations: number, redemptions: number, commissionOpen?: string }} PartnerStats
 */

/**
 * Event counts per partner (plan J11: link opens, voucher activations, redemptions; never "customers").
 * Commission owed = sum of OPEN items, exact to 4 decimals; only when `withCommission`.
 * @param {string[]} partnerIds
 * @param {{ withCommission: boolean }} options
 * @returns {Promise<Map<string, PartnerStats>>}
 */
export async function partnerStats(partnerIds, { withCommission }) {
  /** @type {Map<string, PartnerStats>} */
  const stats = new Map(partnerIds.map((id) => [id, { opens: 0, activations: 0, redemptions: 0, ...(withCommission ? { commissionOpen: '0.0000' } : {}) }]));
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
    const owed = await items
      .aggregate([
        { $match: { ...match, status: 'OPEN', obligationType: { $in: MERCHANT_PAYS } } },
        { $group: { _id: '$partnerId', amount: { $sum: '$amount' } } },
      ])
      .toArray();
    for (const row of owed) /** @type {PartnerStats} */ (stats.get(row._id)).commissionOpen = fromDecimal128(row.amount);
  }
  return stats;
}
