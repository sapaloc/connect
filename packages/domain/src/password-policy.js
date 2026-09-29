export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 32;

/**
 * Plan §8.2. Returns the rules that fail; empty array means the password is accepted.
 * @param {unknown} password
 * @returns {Array<'LENGTH' | 'UPPER' | 'LOWER' | 'DIGIT' | 'SPECIAL'>}
 */
export function passwordPolicyErrors(password) {
  const value = typeof password === 'string' ? password : '';
  const length = [...value].length;
  /** @type {Array<'LENGTH' | 'UPPER' | 'LOWER' | 'DIGIT' | 'SPECIAL'>} */
  const errors = [];
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) errors.push('LENGTH');
  if (!/\p{Lu}/u.test(value)) errors.push('UPPER');
  if (!/\p{Ll}/u.test(value)) errors.push('LOWER');
  if (!/\d/.test(value)) errors.push('DIGIT');
  if (!/[^\p{L}\p{N}]/u.test(value)) errors.push('SPECIAL');
  return errors;
}
