import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  commercialRuleFromPercents,
  fixedRuleFromAmounts,
  isFixedRule,
  parseReferralToken,
  parseVoucherCode,
  partnerAccountRole,
  partnerMediumType,
  percentRuleFromPercents,
  ROLES,
} from '../src/index.js';

describe('partner QR token', () => {
  const token = 'Ab3_-xYz0123456789abcd';

  it('reads a scanned link or the bare token', () => {
    assert.equal(parseReferralToken(`https://connect-uat.vercel.app/r/${token}`), token);
    assert.equal(parseReferralToken(`http://localhost:5173/r/${token}/?utm=qr`), token);
    assert.equal(parseReferralToken(` ${token} `), token);
  });

  it('is never mistaken for a voucher code and the other way round', () => {
    assert.equal(parseReferralToken('https://x.test/v/ABCD2345'), null);
    assert.equal(parseReferralToken('ABCD2345'), null);
    assert.equal(parseVoucherCode(`https://x.test/r/${token}`), null);
  });

  it('medium type follows the relationship kind', () => {
    assert.equal(partnerMediumType('COMPANY'), 'COMPANY_QR');
    assert.equal(partnerMediumType('INDEPENDENT_INDIVIDUAL'), 'PERSONAL_DIGITAL_QR');
  });
});

describe('@money commercial rule from typed percents', () => {
  it('company: commission and company net are derived so the allocation adds up (plan §7.1 example)', () => {
    const { rule, errors } = commercialRuleFromPercents({
      relationshipKind: 'COMPANY',
      totalBudgetPercent: '15',
      customerDiscountPercent: '7',
      individualSharePercent: '3',
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(rule, {
      relationshipKind: 'COMPANY',
      totalBudgetRate: '0.1500',
      customerDiscountRate: '0.0700',
      companyCommissionRate: '0.0800',
      individualShareRate: '0.0300',
      companyNetCommissionRate: '0.0500',
    });
  });

  it('company without an individual share keeps the full commission', () => {
    const { rule } = commercialRuleFromPercents({ relationshipKind: 'COMPANY', totalBudgetPercent: '12.5', customerDiscountPercent: '5' });
    assert.equal(rule?.companyCommissionRate, '0.0750');
    assert.equal(rule?.individualShareRate, '0.0000');
    assert.equal(rule?.companyNetCommissionRate, '0.0750');
  });

  it('independent individual gets total − discount', () => {
    const { rule } = commercialRuleFromPercents({
      relationshipKind: 'INDEPENDENT_INDIVIDUAL',
      totalBudgetPercent: '15',
      customerDiscountPercent: '7',
      individualSharePercent: '99',
    });
    assert.deepEqual(rule, {
      relationshipKind: 'INDEPENDENT_INDIVIDUAL',
      totalBudgetRate: '0.1500',
      customerDiscountRate: '0.0700',
      individualCommissionRate: '0.0800',
    });
  });

  it('refuses a discount below 5%, a discount that leaves no commission, and a share above the commission', () => {
    const errorsOf = (/** @type {Record<string, string>} */ input) =>
      commercialRuleFromPercents({ relationshipKind: 'COMPANY', ...input }).errors;
    assert.deepEqual(errorsOf({ totalBudgetPercent: '15', customerDiscountPercent: '4.99' }), ['CUSTOMER_DISCOUNT_BELOW_MINIMUM']);
    assert.deepEqual(errorsOf({ totalBudgetPercent: '10', customerDiscountPercent: '10' }), ['CUSTOMER_DISCOUNT_NOT_BELOW_TOTAL_BUDGET']);
    assert.deepEqual(errorsOf({ totalBudgetPercent: '15', customerDiscountPercent: '7', individualSharePercent: '8.01' }), [
      'INDIVIDUAL_SHARE_ABOVE_COMMISSION',
    ]);
  });

  it('refuses malformed percents and unknown kinds', () => {
    const errorsOf = (/** @type {Record<string, unknown>} */ input) => commercialRuleFromPercents(/** @type {any} */ (input)).errors;
    assert.deepEqual(errorsOf({ relationshipKind: 'COMPANY', totalBudgetPercent: '15.123', customerDiscountPercent: '7' }), ['TOTAL_BUDGET_INVALID']);
    assert.deepEqual(errorsOf({ relationshipKind: 'COMPANY', totalBudgetPercent: '101', customerDiscountPercent: '-1' }), [
      'TOTAL_BUDGET_INVALID',
      'CUSTOMER_DISCOUNT_INVALID',
    ]);
    assert.deepEqual(errorsOf({ relationshipKind: 'SHOP', totalBudgetPercent: '15', customerDiscountPercent: '7' }), ['RELATIONSHIP_KIND_INVALID']);
  });
});

describe('@money fixed-amount rule', () => {
  it('stores whole VND amounts with 4 decimals', () => {
    const { rule, errors } = fixedRuleFromAmounts({ relationshipKind: 'COMPANY', customerDiscountAmount: '100000', commissionAmount: 150000 });
    assert.deepEqual(errors, []);
    assert.deepEqual(rule, {
      relationshipKind: 'COMPANY',
      pricingModel: 'FIXED_AMOUNT',
      customerDiscountAmount: '100000.0000',
      commissionAmount: '150000.0000',
    });
    assert.equal(isFixedRule(rule), true);
    assert.equal(isFixedRule({ relationshipKind: 'COMPANY' }), false);
  });

  it('refuses zero, fractions, amounts above the cap and unknown kinds', () => {
    const errorsOf = (/** @type {Record<string, unknown>} */ input) =>
      fixedRuleFromAmounts(/** @type {any} */ ({ relationshipKind: 'INDEPENDENT_INDIVIDUAL', ...input })).errors;
    assert.deepEqual(errorsOf({ customerDiscountAmount: '0', commissionAmount: '1000.5' }), [
      'CUSTOMER_DISCOUNT_AMOUNT_INVALID',
      'COMMISSION_AMOUNT_INVALID',
    ]);
    assert.deepEqual(errorsOf({ customerDiscountAmount: '1000000001', commissionAmount: '50000' }), ['CUSTOMER_DISCOUNT_AMOUNT_INVALID']);
    assert.deepEqual(errorsOf({ customerDiscountAmount: '50000', commissionAmount: 'abc' }), ['COMMISSION_AMOUNT_INVALID']);
    assert.deepEqual(errorsOf({ relationshipKind: 'SHOP', customerDiscountAmount: '1', commissionAmount: '1' }), ['RELATIONSHIP_KIND_INVALID']);
  });
});

describe('@money percent terms (discount % + commission %)', () => {
  it('company 10% + 15%: total budget 25%, full commission, no individual share', () => {
    const { rule, errors } = percentRuleFromPercents({ relationshipKind: 'COMPANY', customerDiscountPercent: '10', commissionPercent: '15' });
    assert.deepEqual(errors, []);
    assert.deepEqual(rule, {
      relationshipKind: 'COMPANY',
      totalBudgetRate: '0.2500',
      customerDiscountRate: '0.1000',
      companyCommissionRate: '0.1500',
      individualShareRate: '0.0000',
      companyNetCommissionRate: '0.1500',
    });
    assert.equal(isFixedRule(rule), false);
  });

  it('individual 7.5% + 12.25%', () => {
    const { rule } = percentRuleFromPercents({ relationshipKind: 'INDEPENDENT_INDIVIDUAL', customerDiscountPercent: '7.5', commissionPercent: '12.25' });
    assert.deepEqual(rule, {
      relationshipKind: 'INDEPENDENT_INDIVIDUAL',
      totalBudgetRate: '0.1975',
      customerDiscountRate: '0.0750',
      individualCommissionRate: '0.1225',
    });
  });

  it('refuses zero, 3 decimals, a total above 100%, a discount below 5% and unknown kinds', () => {
    const errorsOf = (/** @type {Record<string, unknown>} */ input) =>
      percentRuleFromPercents(/** @type {any} */ ({ relationshipKind: 'COMPANY', ...input })).errors;
    assert.deepEqual(errorsOf({ customerDiscountPercent: '0', commissionPercent: '10.125' }), [
      'CUSTOMER_DISCOUNT_PERCENT_INVALID',
      'COMMISSION_PERCENT_INVALID',
    ]);
    assert.deepEqual(errorsOf({ customerDiscountPercent: '60', commissionPercent: '40.01' }), ['TOTAL_PERCENT_ABOVE_100']);
    assert.deepEqual(errorsOf({ customerDiscountPercent: '4.99', commissionPercent: '10' }), ['CUSTOMER_DISCOUNT_BELOW_MINIMUM']);
    assert.deepEqual(errorsOf({ relationshipKind: 'SHOP', customerDiscountPercent: '10', commissionPercent: '10' }), ['RELATIONSHIP_KIND_INVALID']);
  });
});

describe('partner account role', () => {
  it('company → Partner admin, independent → Referrer', () => {
    assert.equal(partnerAccountRole('COMPANY'), ROLES.PARTNER_ADMIN);
    assert.equal(partnerAccountRole('INDEPENDENT_INDIVIDUAL'), ROLES.REFERRER);
  });
});
