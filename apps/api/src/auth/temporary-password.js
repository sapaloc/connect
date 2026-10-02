import { passwordPolicyErrors } from '#domain';
import { randomInt } from 'node:crypto';

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SPECIAL = '#%+=?@!';
const ALL = UPPER + LOWER + DIGITS + SPECIAL;
const LENGTH = 16;

/** @param {string} chars */
const pick = (chars) => chars[randomInt(chars.length)];

/**
 * Crypto-random password that meets the policy (one of each class, look-alike characters left out
 * so it can be read aloud or typed from a screen).
 */
export function newTemporaryPassword() {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
  while (chars.length < LENGTH) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const password = chars.join('');
  if (passwordPolicyErrors(password).length) throw new Error('temporary password does not meet the policy');
  return password;
}
