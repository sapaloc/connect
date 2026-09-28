import { health } from '../foundation/health.js';

/**
 * @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} Handler
 */

/** @type {Record<string, Handler>} */
const routes = {
  'GET /api/v1/health': health,
};

/**
 * @param {string} method
 * @param {string} path
 * @returns {Handler | undefined}
 */
export function findRoute(method, path) {
  return routes[`${method} ${path}`];
}
