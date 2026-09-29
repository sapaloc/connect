import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commercialRuleFromPercents, MoneyError, parseVatPercent, partnerAccountRole, ROLES } from '../src/index.js';

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

describe('@money VAT percent', () => {
  it('is stored as a 4-decimal rate', () => {
    assert.equal(parseVatPercent('8'), '0.0800');
    assert.equal(parseVatPercent('10'), '0.1000');
    assert.equal(parseVatPercent('0'), '0.0000');
  });

  it('refuses 100% and more than 2 decimals', () => {
    assert.throws(() => parseVatPercent('100'), MoneyError);
    assert.throws(() => parseVatPercent('8.125'), MoneyError);
    assert.throws(() => parseVatPercent('abc'), MoneyError);
  });
});

describe('partner account role', () => {
  it('company → Partner admin, independent → Referrer', () => {
    assert.equal(partnerAccountRole('COMPANY'), ROLES.PARTNER_ADMIN);
    assert.equal(partnerAccountRole('INDEPENDENT_INDIVIDUAL'), ROLES.REFERRER);
  });
});
