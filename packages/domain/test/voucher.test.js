import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateDirectRedemption,
  effectiveVoucherStatus,
  formatVoucherCode,
  parseDirectDiscount,
  parseVoucherCode,
  ratePercent,
  VOUCHER_CODE_ALPHABET,
} from '../src/index.js';

describe('voucher code', () => {
  it('has no look-alike characters', () => {
    assert.equal(VOUCHER_CODE_ALPHABET.length, 32);
    assert.doesNotMatch(VOUCHER_CODE_ALPHABET, /[01OI]/);
  });

  it('accepts typed codes and scanned links', () => {
    assert.equal(parseVoucherCode('abcd-efgh'), 'ABCDEFGH');
    assert.equal(parseVoucherCode('  ABCD EFGH '), 'ABCDEFGH');
    assert.equal(parseVoucherCode('https://connect-uat.vercel.app/v/ABCD2345'), 'ABCD2345');
    assert.equal(parseVoucherCode('https://x.test/v/abcd-2345?utm=1'), 'ABCD2345');
  });

  it('rejects anything else', () => {
    for (const input of ['', 'ABC', 'ABCDEFG0', 'ABCDEFGHI', 'https://x.test/p/ABCDEFGH', null]) {
      assert.equal(parseVoucherCode(input), null, String(input));
    }
  });

  it('formats in two groups', () => {
    assert.equal(formatVoucherCode('ABCD2345'), 'ABCD-2345');
  });

  it('treats an active voucher past its end as expired', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    assert.equal(effectiveVoucherStatus('ACTIVE', '2026-09-30T16:59:59Z', now), 'EXPIRED');
    assert.equal(effectiveVoucherStatus('ACTIVE', '2026-10-02T00:00:00Z', now), 'ACTIVE');
    assert.equal(effectiveVoucherStatus('REDEEMED', '2026-09-01T00:00:00Z', now), 'REDEEMED');
  });
});

describe('@money direct voucher discount', () => {
  it('stores a percent as a 4-decimal rate', () => {
    assert.equal(parseDirectDiscount('PERCENT', '10'), '0.1000');
    assert.equal(parseDirectDiscount('PERCENT', '12.5'), '0.1250');
    assert.equal(parseDirectDiscount('PERCENT', 100), '1.0000');
    assert.equal(ratePercent('0.1250'), '12.5');
  });

  it('stores a fixed VND amount', () => {
    assert.equal(parseDirectDiscount('AMOUNT', '200000'), '200000.0000');
  });

  it('rejects zero, above 100% and more than 2 percent decimals', () => {
    for (const [type, value] of [['PERCENT', '0'], ['PERCENT', '100.5'], ['PERCENT', '12.345'], ['AMOUNT', '0'], ['AMOUNT', '-5']]) {
      assert.throws(() => parseDirectDiscount(type, value), /discountValue/, `${type} ${value}`);
    }
    assert.throws(() => parseDirectDiscount('FREE', '10'), /discountType/);
  });

  it('VCH-02: 10% of 1,000,000 is 100,000 off, 900,000 to pay', () => {
    assert.deepEqual(calculateDirectRedemption({ discountType: 'PERCENT', discountValue: '0.1000', grossAmount: '1000000' }), {
      grossAmount: '1000000.0000',
      discountAmount: '100000.0000',
      payableAmount: '900000.0000',
    });
  });

  it('keeps 4 decimals on an uneven percent', () => {
    const result = calculateDirectRedemption({ discountType: 'PERCENT', discountValue: '0.1250', grossAmount: '333333' });
    assert.equal(result.discountAmount, '41666.6250');
    assert.equal(result.payableAmount, '291666.3750');
  });

  it('VCH-03: a fixed 200,000 on a 150,000 bill gives 150,000 off, 0 to pay', () => {
    const result = calculateDirectRedemption({ discountType: 'AMOUNT', discountValue: '200000.0000', grossAmount: 150000 });
    assert.equal(result.discountAmount, '150000.0000');
    assert.equal(result.payableAmount, '0.0000');
  });

  it('enforces the minimum bill', () => {
    const voucher = { discountType: 'AMOUNT', discountValue: '50000.0000', minBillAmount: '500000.0000' };
    assert.throws(() => calculateDirectRedemption({ ...voucher, grossAmount: '499999' }), { code: 'BELOW_MIN_BILL' });
    assert.equal(calculateDirectRedemption({ ...voucher, grossAmount: '500000' }).payableAmount, '450000.0000');
  });

  it('rejects a zero bill', () => {
    assert.throws(() => calculateDirectRedemption({ discountType: 'PERCENT', discountValue: '0.1000', grossAmount: '0' }), {
      code: 'AMOUNT_NOT_POSITIVE',
    });
  });
});
