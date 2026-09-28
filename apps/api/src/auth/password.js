import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { SCRYPT } from '../config/security.js';

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {{ N: number, r: number, p: number }} cost
 * @returns {Promise<Buffer>}
 */
function derive(password, salt, cost) {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      SCRYPT.keyLength,
      { ...cost, maxmem: SCRYPT.maxmem },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/**
 * Format: scrypt$N$r$p$salt$key (base64url), so the cost can be raised later
 * without invalidating existing hashes.
 * @param {string} password
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p } = SCRYPT;
  const key = await derive(password, salt, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** @type {Promise<string> | undefined} */
let dummyHash;

/**
 * Always spends one hash, even for unknown accounts, so response time does not reveal
 * whether an email exists.
 * @param {string} password
 * @param {string | null | undefined} stored
 */
export async function verifyPassword(password, stored) {
  const target = stored || (await (dummyHash ??= hashPassword(randomBytes(12).toString('hex'))));
  const [scheme, N, r, p, salt, key] = target.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p) });
  return Boolean(stored) && actual.length === expected.length && timingSafeEqual(actual, expected);
}
