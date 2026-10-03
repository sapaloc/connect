import { authRoutes } from '../foundation/auth-routes.js';
import { fileRoutes } from '../files/files.js';
import { health } from '../foundation/health.js';
import { userRoutes } from '../foundation/user-routes.js';
import { applicationRoutes } from '../merchants/application-routes.js';
import { dashboardRoutes } from '../merchants/dashboard.js';
import { merchantRoutes } from '../merchants/merchant-routes.js';
import { partnerApplicationRoutes } from '../partners/application-routes.js';
import { historyRoutes } from '../partners/history.js';
import { joinRoutes } from '../partners/join-routes.js';
import { myRoutes } from '../partners/my-routes.js';
import { partnerRoutes } from '../partners/partner-routes.js';
import { partnerProfileRoutes } from '../partners/profile-routes.js';
import { reportRoutes } from '../partners/report.js';
import { reviewRoutes } from '../partners/review-routes.js';
import { referralRoutes } from '../referrals/referral-routes.js';
import { confirmationRoutes } from '../vouchers/confirmation-routes.js';
import { voucherRoutes } from '../vouchers/voucher-routes.js';

/**
 * @typedef {{ params: Record<string, string>, requestId: string, session?: import('../auth/session.js').Session }} Context
 * @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, ctx: Context) => Promise<void>} Handler
 * @typedef {{ method: string, path: string, handler: Handler }} RouteDef
 */

/** @type {RouteDef[]} */
const definitions = [
  { method: 'GET', path: '/api/v1/health', handler: health },
  ...authRoutes,
  ...userRoutes,
  ...merchantRoutes,
  ...applicationRoutes,
  ...partnerApplicationRoutes,
  ...partnerProfileRoutes,
  ...joinRoutes,
  ...partnerRoutes,
  ...referralRoutes,
  ...myRoutes,
  ...historyRoutes,
  ...reportRoutes,
  ...dashboardRoutes,
  ...fileRoutes,
  ...voucherRoutes,
  ...confirmationRoutes,
  ...reviewRoutes,
];

const routes = definitions.map(({ method, path, handler }) => {
  /** @type {string[]} */
  const keys = [];
  const pattern = path.replace(/:([a-zA-Z]+)/g, (_match, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { method, regex: new RegExp(`^${pattern}$`), keys, handler };
});

/**
 * @param {string} method
 * @param {string} path
 * @returns {{ handler: Handler, params: Record<string, string> } | { methodNotAllowed: true } | undefined}
 */
export function findRoute(method, path) {
  let pathMatched = false;
  for (const route of routes) {
    const match = route.regex.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    /** @type {Record<string, string>} */
    const params = {};
    route.keys.forEach((key, index) => {
      params[key] = safeDecode(match[index + 1]);
    });
    return { handler: route.handler, params };
  }
  return pathMatched ? { methodNotAllowed: true } : undefined;
}

/** @param {string} value */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
