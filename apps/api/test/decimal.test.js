import assert from 'node:assert/strict';
import { Decimal128 } from 'mongodb';
import { describe, it } from 'node:test';
import { fromDecimal128, toDecimal128 } from '../src/db/decimal.js';

describe('@money Decimal128 storage', () => {
  it('round-trips 4-decimal strings without float', () => {
    for (const value of ['2198181.8182', '0.0700', '109909.0910', '99999999999999.9999', '0.0000']) {
      assert.equal(fromDecimal128(toDecimal128(value)), value);
    }
  });

  it('normalizes shorter stored values to 4 decimals', () => {
    assert.equal(fromDecimal128(Decimal128.fromString('12.5')), '12.5000');
    assert.equal(fromDecimal128(Decimal128.fromString('7')), '7.0000');
  });

  it('rejects numbers and imprecise strings', () => {
    // @ts-expect-error number on purpose
    assert.throws(() => toDecimal128(0.07), /4 decimals/);
    assert.throws(() => toDecimal128('0.07'), /4 decimals/);
    assert.throws(() => fromDecimal128(Decimal128.fromString('0.00001')), /more than 4/);
  });
});
