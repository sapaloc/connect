import { createHmac, randomBytes } from 'node:crypto';
import { env, requireEnv } from '../config/env.js';

export function newToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Only this hash is stored (session, invitation, reset). Keyed with SESSION_SECRET so a
 * leaked database alone cannot be used to forge lookups; rotating the secret signs everyone out.
 * @param {string} token
 */
export function hashToken(token) {
  requireEnv('sessionSecret');
  return createHmac('sha256', env.sessionSecret).update(token).digest();
}
