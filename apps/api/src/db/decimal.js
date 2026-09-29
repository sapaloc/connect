import { Decimal128 } from 'mongodb';

/**
 * Money and rates are stored as Decimal128 and cross into JavaScript only as 4-decimal strings
 * (plan §7.1); never through Number.
 * @param {string} value e.g. "2198181.8182"
 */
export function toDecimal128(value) {
  if (typeof value !== 'string' || !/^-?\d+\.\d{4}$/.test(value)) {
    throw new Error(`Money must be a string with exactly 4 decimals, got ${JSON.stringify(value)}`);
  }
  return Decimal128.fromString(value);
}

/**
 * @param {Decimal128} value
 * @returns {string} normalized to 4 decimals, e.g. "0.0700"
 */
export function fromDecimal128(value) {
  if (!(value instanceof Decimal128)) throw new Error('Expected a Decimal128');
  const [whole, fraction = ''] = value.toString().split('.');
  if (fraction.length > 4) throw new Error(`Stored money has more than 4 decimals: ${value}`);
  return `${whole}.${fraction.padEnd(4, '0')}`;
}

/** $jsonSchema fragment for a money or rate field. */
export const decimalField = Object.freeze({ bsonType: 'decimal' });
