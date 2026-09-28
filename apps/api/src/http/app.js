import { findRoute } from './router.js';
import { sendError } from './respond.js';

/**
 * Shared by the local Node server and the Vercel function.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handle(req, res) {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  const route = findRoute(req.method ?? 'GET', path);
  if (!route) {
    sendError(res, 404, 'NOT_FOUND', 'Route not found');
    return;
  }
  try {
    await route(req, res);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', path, err: error.message }));
    if (!res.headersSent) sendError(res, 500, 'INTERNAL', 'Unexpected error');
  }
}
