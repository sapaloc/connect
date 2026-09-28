import { env } from '../config/env.js';
import { HttpError } from './errors.js';

const MAX_BODY_BYTES = 16 * 1024;

/**
 * @param {import('node:http').IncomingMessage & { body?: unknown }} req
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }

  // Vercel's Node runtime may already have buffered and parsed the body.
  let parsed;
  try {
    parsed = req.body !== undefined ? req.body : JSON.parse((await readRaw(req)) || '{}');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object');
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/** @param {import('node:http').IncomingMessage} req */
async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {import('node:http').IncomingMessage} req */
export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

/** @param {import('node:http').IncomingMessage} req */
function requestHost(req) {
  return String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
}

/**
 * Blocks cross-site writes: the browser always sends Origin on POST from another site.
 * @param {import('node:http').IncomingMessage} req
 */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (env.appOrigin && origin === env.appOrigin) return true;
  try {
    return new URL(origin).host === requestHost(req);
  } catch {
    return false;
  }
}

/** Base URL for links shown to admins (invitation, password reset). */
export function publicOrigin(req) {
  if (env.appOrigin) return env.appOrigin;
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
  return `${proto}://${requestHost(req)}`;
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @param {{ max?: number, optional?: boolean }} [options]
 */
export function stringField(body, key, { max = 200, optional = false } = {}) {
  const value = body[key];
  if (value === undefined || value === null || value === '') {
    if (optional) return '';
    throw new HttpError(422, 'VALIDATION', `${key} is required`, { details: { field: key } });
  }
  if (typeof value !== 'string' || value.length > max) {
    throw new HttpError(422, 'VALIDATION', `${key} is invalid`, { details: { field: key } });
  }
  return value;
}
