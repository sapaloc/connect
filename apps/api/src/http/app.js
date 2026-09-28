import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { isSameOrigin } from './request.js';
import { sendError } from './respond.js';
import { findRoute } from './router.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Shared by the local Node server and the Vercel function.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handle(req, res) {
  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  const requestId = String(req.headers['x-vercel-id'] ?? randomUUID());
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const route = findRoute(method, path);
  if (!route) {
    sendError(res, 404, 'NOT_FOUND', 'Route not found');
    return;
  }
  if ('methodNotAllowed' in route) {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return;
  }
  if (!SAFE_METHODS.has(method) && !isSameOrigin(req)) {
    sendError(res, 403, 'ORIGIN_MISMATCH', 'Cross-site request blocked');
    return;
  }

  try {
    await route.handler(req, res, { params: route.params, requestId });
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof HttpError) {
      sendError(res, error.status, error.code, error.message, { details: error.details, headers: error.headers });
      return;
    }
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', path, requestId, err: error.message }));
    sendError(res, 500, 'INTERNAL', 'Unexpected error');
  }
}
