import { env } from '../config/env.js';

/**
 * @typedef {'APPLICATION_RECEIVED' | 'APPLICATION_NEW_FOR_ADMINS' | 'APPLICATION_APPROVED' | 'APPLICATION_REJECTED'
 *   | 'TEMPORARY_PASSWORD_REISSUED'} NotifyType
 * @typedef {{ to: string[], language?: 'en' | 'vi', [key: string]: unknown }} NotifyPayload
 */

/**
 * The single place that tells people what happened. No mail provider yet (#85), so it only logs the
 * type and recipients: the payload may hold a temporary password and must never be logged.
 * Never throws, so a notification problem cannot undo the action that triggered it.
 * @param {NotifyType} type
 * @param {NotifyPayload} payload
 */
export async function notify(type, payload) {
  try {
    if (env.logLevel === 'error') return;
    console.log(JSON.stringify({ level: 'info', msg: 'notify', type, to: payload.to }));
  } catch {
    // Logging must not fail the request.
  }
}
