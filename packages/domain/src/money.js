import Decimal from 'decimal.js';

/**
 * The only place money is computed (plan §7, §7.1). Amounts and rates travel as strings with
 * exactly 4 decimals ("2198181.8182", "0.0700") and are stored as Decimal128; never JS numbers.
 */

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const MONEY_SCALE = 4;
export const MIN_CUSTOMER_DISCOUNT_RATE = '0.0500';
export const MAX_AMOUNT = '99999999999999.9999';

export const RELATIONSHIP_KINDS = Object.freeze({
  COMPANY: 'COMPANY',
  INDEPENDENT_INDIVIDUAL: 'INDEPENDENT_INDIVIDUAL',
});

export const OBLIGATION_TYPES = Object.freeze({
  TENANT_TO_COMPANY: 'TENANT_TO_COMPANY',
  COMPANY_TO_AFFILIATED_INDIVIDUAL: 'COMPANY_TO_AFFILIATED_INDIVIDUAL',
  TENANT_TO_INDEPENDENT_INDIVIDUAL: 'TENANT_TO_INDEPENDENT_INDIVIDUAL',
});

const DECIMAL_PATTERN = /^\d{1,14}(\.\d{1,4})?$/;

/**
 * Parses a non-negative amount or rate with at most 4 decimals. Numbers are accepted only
 * when they are safe integers (e.g. a VND bill typed as 2600000), never fractions.
 * @param {unknown} value
 * @param {string} field
 */
export function parseDecimal(value, field) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !DECIMAL_PATTERN.test(text.trim())) {
    throw new MoneyError('INVALID_DECIMAL', `${field} must be a non-negative decimal with at most 4 decimals`, field);
  }
  return new D(text.trim());
}

/** @param {Decimal} value */
const stored = (value) => value.toDecimalPlaces(MONEY_SCALE, D.ROUND_HALF_UP);

/** @param {Decimal} value */
const text = (value) => value.toFixed(MONEY_SCALE);

export class MoneyError extends Error {
  /** @param {string} code @param {string} message @param {string} [field] */
  constructor(code, message, field) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

/**
 * @typedef {{
 *   relationshipKind: 'COMPANY' | 'INDEPENDENT_INDIVIDUAL',
 *   totalBudgetRate: string,
 *   customerDiscountRate: string,
 *   companyCommissionRate?: string,
 *   individualShareRate?: string,
 *   companyNetCommissionRate?: string,
 *   individualCommissionRate?: string,
 * }} CommercialRule
 */

/**
 * Allocation rules (REQ §6, plan §7): full allocation, no remainder, discount >= 5%.
 * Returns error codes; an empty array means the rule can be activated.
 * @param {CommercialRule} rule
 * @returns {string[]}
 */
export function commercialRuleErrors(rule) {
  const errors = [];
  /** @param {keyof CommercialRule} field */
  const rate = (field) => {
    try {
      const value = parseDecimal(rule[field], field);
      if (value.gt(1)) errors.push(`${field.toUpperCase()}_ABOVE_100`);
      return value;
    } catch {
      errors.push(`${field.toUpperCase()}_INVALID`);
      return null;
    }
  };

  const total = rate('totalBudgetRate');
  const discount = rate('customerDiscountRate');
  if (discount && discount.lt(MIN_CUSTOMER_DISCOUNT_RATE)) errors.push('CUSTOMER_DISCOUNT_BELOW_MINIMUM');

  if (rule.relationshipKind === RELATIONSHIP_KINDS.COMPANY) {
    const commission = rate('companyCommissionRate');
    const share = rate('individualShareRate');
    const companyNet = rate('companyNetCommissionRate');
    if (total && discount && commission && !discount.plus(commission).eq(total)) errors.push('ALLOCATION_NOT_EQUAL_TOTAL_BUDGET');
    if (commission && share && companyNet && !share.plus(companyNet).eq(commission)) {
      errors.push('SHARE_NOT_EQUAL_COMPANY_COMMISSION');
    }
  } else if (rule.relationshipKind === RELATIONSHIP_KINDS.INDEPENDENT_INDIVIDUAL) {
    const commission = rate('individualCommissionRate');
    if (total && discount && commission && !discount.plus(commission).eq(total)) errors.push('ALLOCATION_NOT_EQUAL_TOTAL_BUDGET');
  } else {
    errors.push('RELATIONSHIP_KIND_INVALID');
  }
  return errors;
}

/**
 * @typedef {{ obligationType: string, rate: string, baseAmount: string, amount: string }} CommissionItem
 * @typedef {{
 *   grossInvoiceAmount: string,
 *   customerDiscountRate: string,
 *   customerDiscountAmount: string,
 *   discountedGrossPayable: string,
 *   vatRate: string,
 *   netNetCommissionBase: string,
 *   vatAmount: string,
 *   companyNetCommissionAmount: string | null,
 *   commissionItems: CommissionItem[],
 * }} RedemptionAmounts
 */

/**
 * Redemption money, in the binding order (REQ §14, plan §7.1). Each step uses the stored value of the
 * previous one rounded half-up to 4 decimals; the last component of a split is the residual, so parts
 * always add up to their total exactly.
 * @param {{
 *   grossInvoiceAmount: unknown,
 *   vatRate: unknown,
 *   rule: CommercialRule,
 *   hasAffiliatedReferrer?: boolean,
 * }} input
 * @returns {RedemptionAmounts}
 */
export function calculateRedemption({ grossInvoiceAmount, vatRate, rule, hasAffiliatedReferrer = false }) {
  const ruleErrors = commercialRuleErrors(rule);
  if (ruleErrors.length) throw new MoneyError('COMMERCIAL_RULE_INVALID', ruleErrors.join(', '));
  const gross = parseDecimal(grossInvoiceAmount, 'grossInvoiceAmount');
  if (gross.lte(0)) throw new MoneyError('AMOUNT_NOT_POSITIVE', 'grossInvoiceAmount must be greater than 0', 'grossInvoiceAmount');
  const vat = parseDecimal(vatRate, 'vatRate');
  if (vat.gte(1)) throw new MoneyError('VAT_RATE_INVALID', 'vatRate must be below 1', 'vatRate');

  const discountRate = new D(rule.customerDiscountRate);
  const discount = stored(gross.times(discountRate));
  const payable = gross.minus(discount);
  const base = stored(payable.div(vat.plus(1)));
  const vatAmount = payable.minus(base);

  /** @type {CommissionItem[]} */
  const items = [];
  let companyNet = null;
  if (rule.relationshipKind === RELATIONSHIP_KINDS.COMPANY) {
    const commissionRate = new D(/** @type {string} */ (rule.companyCommissionRate));
    const commission = stored(base.times(commissionRate));
    items.push({ obligationType: OBLIGATION_TYPES.TENANT_TO_COMPANY, rate: text(commissionRate), baseAmount: text(base), amount: text(commission) });
    // Company / Location media without an affiliated referrer: no individual share (plan §7).
    const shareRate = hasAffiliatedReferrer ? new D(/** @type {string} */ (rule.individualShareRate)) : new D(0);
    const share = stored(base.times(shareRate));
    if (share.gt(0)) {
      items.push({
        obligationType: OBLIGATION_TYPES.COMPANY_TO_AFFILIATED_INDIVIDUAL,
        rate: text(shareRate),
        baseAmount: text(base),
        amount: text(share),
      });
    }
    companyNet = text(commission.minus(share));
  } else {
    const commissionRate = new D(/** @type {string} */ (rule.individualCommissionRate));
    items.push({
      obligationType: OBLIGATION_TYPES.TENANT_TO_INDEPENDENT_INDIVIDUAL,
      rate: text(commissionRate),
      baseAmount: text(base),
      amount: text(stored(base.times(commissionRate))),
    });
  }

  return {
    grossInvoiceAmount: text(gross),
    customerDiscountRate: text(discountRate),
    customerDiscountAmount: text(discount),
    discountedGrossPayable: text(payable),
    vatRate: text(vat),
    netNetCommissionBase: text(base),
    vatAmount: text(vatAmount),
    companyNetCommissionAmount: companyNet,
    commissionItems: items,
  };
}

export const DISCOUNT_TYPES = Object.freeze({
  PERCENT: 'PERCENT',
  AMOUNT: 'AMOUNT',
});

/**
 * Discount of a merchant-issued (DIRECT) voucher, as stored: PERCENT is typed as a percent with at most
 * 2 decimals ("12.5") and stored as a rate ("0.1250"); AMOUNT is a VND amount ("200000.0000").
 * @param {unknown} discountType
 * @param {unknown} value
 */
export function parseDirectDiscount(discountType, value) {
  if (discountType === DISCOUNT_TYPES.PERCENT) {
    const percent = parseDecimal(value, 'discountValue');
    if (percent.lte(0) || percent.gt(100) || percent.decimalPlaces() > 2) {
      throw new MoneyError('DISCOUNT_INVALID', 'discountValue must be a percent above 0 and at most 100', 'discountValue');
    }
    return text(percent.div(100));
  }
  if (discountType === DISCOUNT_TYPES.AMOUNT) {
    const amount = parseDecimal(value, 'discountValue');
    if (amount.lte(0)) throw new MoneyError('DISCOUNT_INVALID', 'discountValue must be greater than 0', 'discountValue');
    return text(amount);
  }
  throw new MoneyError('DISCOUNT_TYPE_INVALID', 'discountType must be PERCENT or AMOUNT', 'discountType');
}

/**
 * Bill of a DIRECT voucher redemption. PERCENT: bill x rate, stored half-up to 4 decimals.
 * AMOUNT: the fixed amount, capped at the bill so the customer never pays less than 0.
 * @param {{ discountType: string, discountValue: string, minBillAmount?: string | null, grossAmount: unknown }} input
 */
export function calculateDirectRedemption({ discountType, discountValue, minBillAmount = null, grossAmount }) {
  const gross = parseDecimal(grossAmount, 'grossAmount');
  if (gross.lte(0)) throw new MoneyError('AMOUNT_NOT_POSITIVE', 'grossAmount must be greater than 0', 'grossAmount');
  if (minBillAmount && gross.lt(minBillAmount)) {
    throw new MoneyError('BELOW_MIN_BILL', 'grossAmount is below the minimum bill of this voucher', 'grossAmount');
  }
  const value = new D(discountValue);
  const discount = discountType === DISCOUNT_TYPES.PERCENT ? stored(gross.times(value)) : D.min(value, gross);
  return { grossAmount: text(gross), discountAmount: text(discount), payableAmount: text(gross.minus(discount)) };
}

/**
 * Stored rate as a percent for display: "0.1250" -> "12.5".
 * @param {string} rate
 */
export function ratePercent(rate) {
  return new D(rate).times(100).toDecimalPlaces(2, D.ROUND_HALF_UP).toString();
}

/**
 * Whole VND, half-up. For display only; never store or add displayed values.
 * @param {string} amount
 */
export function toVnd(amount) {
  return new D(amount).toDecimalPlaces(0, D.ROUND_HALF_UP).toFixed(0);
}

/**
 * Display split that reconciles on screen: every part rounded to VND except the last,
 * which is the displayed total minus the other displayed parts (plan §7.1 rule 3).
 * @param {string} total
 * @param {string[]} parts stored parts, the last one being the residual
 */
export function displaySplit(total, parts) {
  const shown = parts.slice(0, -1).map(toVnd);
  const last = new D(toVnd(total)).minus(shown.reduce((sum, part) => sum.plus(part), new D(0)));
  return { total: toVnd(total), parts: [...shown, last.toFixed(0)] };
}

/**
 * Display amounts for a redemption, reconciled like the §7.1 table.
 * @param {RedemptionAmounts} amounts
 */
export function displayRedemption(amounts) {
  const payable = displaySplit(amounts.grossInvoiceAmount, [amounts.customerDiscountAmount, amounts.discountedGrossPayable]);
  const vat = displaySplit(amounts.discountedGrossPayable, [amounts.netNetCommissionBase, amounts.vatAmount]);
  const company = amounts.commissionItems.find((item) => item.obligationType === OBLIGATION_TYPES.TENANT_TO_COMPANY);
  const share = amounts.commissionItems.find((item) => item.obligationType === OBLIGATION_TYPES.COMPANY_TO_AFFILIATED_INDIVIDUAL);
  const companySplit =
    company && amounts.companyNetCommissionAmount !== null
      ? displaySplit(company.amount, [share?.amount ?? '0', amounts.companyNetCommissionAmount])
      : null;
  return {
    grossInvoiceAmount: payable.total,
    customerDiscountAmount: payable.parts[0],
    discountedGrossPayable: payable.parts[1],
    netNetCommissionBase: vat.parts[0],
    vatAmount: vat.parts[1],
    commissionItems: amounts.commissionItems.map((item) => ({
      obligationType: item.obligationType,
      amount:
        companySplit && item.obligationType === OBLIGATION_TYPES.COMPANY_TO_AFFILIATED_INDIVIDUAL
          ? companySplit.parts[0]
          : toVnd(item.amount),
    })),
    companyNetCommissionAmount: companySplit ? companySplit.parts[1] : null,
  };
}

/**
 * Sum of stored amounts (e.g. commission report per partner), still 4 decimals.
 * @param {string[]} amounts
 */
export function sumAmounts(amounts) {
  return text(amounts.reduce((sum, amount) => sum.plus(amount), new D(0)));
}
