import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateRedemption,
  commercialRuleErrors,
  displayRedemption,
  displaySplit,
  MoneyError,
  OBLIGATION_TYPES,
  parseDecimal,
  sumAmounts,
  toVnd,
} from '../src/index.js';

/** Plan §7.1: the single worked example used by code, tests, diagrams and reports. */
const COMPANY_RULE = Object.freeze({
  relationshipKind: /** @type {const} */ ('COMPANY'),
  totalBudgetRate: '0.1500',
  customerDiscountRate: '0.0700',
  companyCommissionRate: '0.0800',
  individualShareRate: '0.0300',
  companyNetCommissionRate: '0.0500',
});

const INDEPENDENT_RULE = Object.freeze({
  relationshipKind: /** @type {const} */ ('INDEPENDENT_INDIVIDUAL'),
  totalBudgetRate: '0.1500',
  customerDiscountRate: '0.0700',
  individualCommissionRate: '0.0800',
});

describe('@money §7.1 fixture (company partner with affiliated referrer)', () => {
  const amounts = calculateRedemption({
    grossInvoiceAmount: '2600000',
    vatRate: '0.1000',
    rule: COMPANY_RULE,
    hasAffiliatedReferrer: true,
  });

  it('stores every step at 4 decimals exactly as the fixture', () => {
    assert.equal(amounts.grossInvoiceAmount, '2600000.0000');
    assert.equal(amounts.customerDiscountAmount, '182000.0000');
    assert.equal(amounts.discountedGrossPayable, '2418000.0000');
    assert.equal(amounts.netNetCommissionBase, '2198181.8182');
    assert.equal(amounts.vatAmount, '219818.1818');
    assert.deepEqual(amounts.commissionItems, [
      { obligationType: 'TENANT_TO_COMPANY', rate: '0.0800', baseAmount: '2198181.8182', amount: '175854.5455' },
      { obligationType: 'COMPANY_TO_AFFILIATED_INDIVIDUAL', rate: '0.0300', baseAmount: '2198181.8182', amount: '65945.4545' },
    ]);
    assert.equal(amounts.companyNetCommissionAmount, '109909.0910');
  });

  it('parts add up to their totals with no 0.0001 drift', () => {
    assert.equal(sumAmounts([amounts.netNetCommissionBase, amounts.vatAmount]), amounts.discountedGrossPayable);
    assert.equal(sumAmounts([amounts.customerDiscountAmount, amounts.discountedGrossPayable]), amounts.grossInvoiceAmount);
    assert.equal(
      sumAmounts([amounts.commissionItems[1].amount, /** @type {string} */ (amounts.companyNetCommissionAmount)]),
      amounts.commissionItems[0].amount,
    );
  });

  it('displays whole VND and the displayed table still reconciles', () => {
    assert.deepEqual(displayRedemption(amounts), {
      grossInvoiceAmount: '2600000',
      customerDiscountAmount: '182000',
      discountedGrossPayable: '2418000',
      netNetCommissionBase: '2198182',
      vatAmount: '219818',
      commissionItems: [
        { obligationType: 'TENANT_TO_COMPANY', amount: '175855' },
        { obligationType: 'COMPANY_TO_AFFILIATED_INDIVIDUAL', amount: '65945' },
      ],
      companyNetCommissionAmount: '109910',
    });
  });

  it('commission is on Net/Net excluding VAT, never on the gross bill', () => {
    assert.notEqual(amounts.commissionItems[0].amount, '208000.0000');
    assert.notEqual(amounts.commissionItems[0].amount, '193440.0000');
  });
});

describe('@money other attribution cases', () => {
  it('company or location media without an affiliated referrer: company keeps the full commission', () => {
    const amounts = calculateRedemption({ grossInvoiceAmount: 2600000, vatRate: '0.1000', rule: COMPANY_RULE });
    assert.deepEqual(
      amounts.commissionItems.map((item) => item.obligationType),
      [OBLIGATION_TYPES.TENANT_TO_COMPANY],
    );
    assert.equal(amounts.companyNetCommissionAmount, '175854.5455');
  });

  it('independent individual referrer is paid by the Spa directly', () => {
    const amounts = calculateRedemption({ grossInvoiceAmount: '2600000', vatRate: '0.1000', rule: INDEPENDENT_RULE });
    assert.deepEqual(amounts.commissionItems, [
      { obligationType: 'TENANT_TO_INDEPENDENT_INDIVIDUAL', rate: '0.0800', baseAmount: '2198181.8182', amount: '175854.5455' },
    ]);
    assert.equal(amounts.companyNetCommissionAmount, null);
  });

  it('rounds half-up at the 4th decimal', () => {
    const amounts = calculateRedemption({ grossInvoiceAmount: '1000001', vatRate: '0.1000', rule: INDEPENDENT_RULE });
    assert.equal(amounts.customerDiscountAmount, '70000.0700');
    assert.equal(amounts.netNetCommissionBase, '845455.3909');
    assert.equal(amounts.commissionItems[0].amount, '67636.4313');
    assert.equal(sumAmounts([amounts.netNetCommissionBase, amounts.vatAmount]), amounts.discountedGrossPayable);
  });

  it('VAT 0% leaves the base equal to the payable amount', () => {
    const amounts = calculateRedemption({ grossInvoiceAmount: '500000', vatRate: '0.0000', rule: INDEPENDENT_RULE });
    assert.equal(amounts.netNetCommissionBase, amounts.discountedGrossPayable);
    assert.equal(amounts.vatAmount, '0.0000');
  });
});

describe('@money commercial rule validation (REQ §6)', () => {
  it('accepts full allocations', () => {
    assert.deepEqual(commercialRuleErrors(COMPANY_RULE), []);
    assert.deepEqual(commercialRuleErrors(INDEPENDENT_RULE), []);
  });

  it('discount + commission must equal the total budget', () => {
    assert.deepEqual(commercialRuleErrors({ ...COMPANY_RULE, companyCommissionRate: '0.0700', companyNetCommissionRate: '0.0400' }), [
      'ALLOCATION_NOT_EQUAL_TOTAL_BUDGET',
    ]);
    assert.deepEqual(commercialRuleErrors({ ...INDEPENDENT_RULE, individualCommissionRate: '0.0900' }), [
      'ALLOCATION_NOT_EQUAL_TOTAL_BUDGET',
    ]);
  });

  it('individual share + company net must equal the company commission', () => {
    assert.deepEqual(commercialRuleErrors({ ...COMPANY_RULE, individualShareRate: '0.0400' }), ['SHARE_NOT_EQUAL_COMPANY_COMMISSION']);
  });

  it('customer discount is at least 5%', () => {
    assert.deepEqual(
      commercialRuleErrors({ ...INDEPENDENT_RULE, customerDiscountRate: '0.0499', individualCommissionRate: '0.1001' }),
      ['CUSTOMER_DISCOUNT_BELOW_MINIMUM'],
    );
    assert.deepEqual(
      commercialRuleErrors({ ...INDEPENDENT_RULE, customerDiscountRate: '0.0500', individualCommissionRate: '0.1000' }),
      [],
    );
  });

  it('rejects floats, negatives, more than 4 decimals and unknown kinds', () => {
    // @ts-expect-error float on purpose
    assert.ok(commercialRuleErrors({ ...INDEPENDENT_RULE, customerDiscountRate: 0.07 }).includes('CUSTOMERDISCOUNTRATE_INVALID'));
    assert.ok(commercialRuleErrors({ ...INDEPENDENT_RULE, totalBudgetRate: '-0.1500' }).includes('TOTALBUDGETRATE_INVALID'));
    assert.ok(commercialRuleErrors({ ...INDEPENDENT_RULE, totalBudgetRate: '0.15000' }).includes('TOTALBUDGETRATE_INVALID'));
    // @ts-expect-error unknown kind on purpose
    assert.deepEqual(commercialRuleErrors({ ...INDEPENDENT_RULE, relationshipKind: 'CUSTOMER' }), ['RELATIONSHIP_KIND_INVALID']);
  });

  it('refuses to calculate with an invalid rule or amount', () => {
    assert.throws(
      () => calculateRedemption({ grossInvoiceAmount: '100000', vatRate: '0.1000', rule: { ...INDEPENDENT_RULE, individualCommissionRate: '0.0100' } }),
      (error) => error instanceof MoneyError && error.code === 'COMMERCIAL_RULE_INVALID',
    );
    assert.throws(() => calculateRedemption({ grossInvoiceAmount: '0', vatRate: '0.1000', rule: INDEPENDENT_RULE }), /greater than 0/);
    assert.throws(() => calculateRedemption({ grossInvoiceAmount: 2600000.5, vatRate: '0.1000', rule: INDEPENDENT_RULE }), MoneyError);
    assert.throws(() => calculateRedemption({ grossInvoiceAmount: '100000', vatRate: '1.0000', rule: INDEPENDENT_RULE }), /vatRate/);
  });
});

describe('@money helpers', () => {
  it('parses integers and decimal strings, never fractional numbers', () => {
    assert.equal(parseDecimal(2600000, 'x').toFixed(4), '2600000.0000');
    assert.equal(parseDecimal(' 12.5 ', 'x').toFixed(4), '12.5000');
    assert.throws(() => parseDecimal(0.1, 'x'), MoneyError);
    assert.throws(() => parseDecimal('1e5', 'x'), MoneyError);
  });

  it('display split keeps the shown total', () => {
    assert.deepEqual(displaySplit('100.0000', ['33.3333', '33.3333', '33.3334']), { total: '100', parts: ['33', '33', '34'] });
    assert.equal(toVnd('0.5000'), '1');
    assert.equal(toVnd('0.4999'), '0');
  });

  it('period report sums stored amounts, then displays once', () => {
    const total = sumAmounts(['175854.5455', '175854.5455', '175854.5455']);
    assert.equal(total, '527563.6365');
    assert.equal(toVnd(total), '527564');
  });
});
