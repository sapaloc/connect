import { isLocalOrTest } from '../config/env.js';

/** @param {string | undefined} header */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const cookies = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookie values set by other apps on the same domain.
    }
  }
  return cookies;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {number} maxAgeSeconds
 */
export function serializeCookie(name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (!isLocalOrTest) parts.push('Secure');
  return parts.join('; ');
}
