import { recordAudit } from '../audit/audit.js';
import { env } from '../config/env.js';
import { sendMail } from './mail.js';
import { renderEmail } from './templates.js';

/**
 * @typedef {'APPLICATION_RECEIVED' | 'APPLICATION_NEW_FOR_ADMINS' | 'APPLICATION_APPROVED' | 'APPLICATION_REJECTED'
 *   | 'TEMPORARY_PASSWORD_REISSUED' | 'PARTNER_APPLICATION_RECEIVED' | 'PARTNER_APPLICATION_NEW_FOR_ADMINS'
 *   | 'PARTNER_APPLICATION_APPROVED' | 'PARTNER_APPLICATION_REJECTED'} NotifyType
 * @typedef {{ email: string, language?: 'en' | 'vi' }} Recipient
 * @typedef {{ to: Recipient[] } & import('./templates.js').EmailData} NotifyPayload
 * @typedef {Omit<import('../audit/audit.js').AuditInput, 'eventType'>} AuditContext
 */

/** @param {Record<string, unknown>} entry */
function logInfo(entry) {
  if (env.logLevel !== 'error') console.log(JSON.stringify({ level: 'info', ...entry }));
}

/**
 * @param {NotifyType} type
 * @param {Recipient} recipient
 * @param {import('./templates.js').EmailData} data
 * @param {AuditContext} context
 */
async function deliver(type, recipient, data, context) {
  const to = recipient.email;
  const email = renderEmail(type, recipient.language, data);
  const result = await sendMail({ to, ...email });
  if (result.sent) {
    logInfo({ msg: 'email sent', type, to });
    return true;
  }
  if (result.reason === 'NOT_CONFIGURED') {
    // The email may hold a temporary password: only a developer's own terminal may show it.
    if (env.appEnv === 'local') {
      if (env.logLevel !== 'error') console.log(`\n--- email not sent (no mail settings) ---\nTo: ${to}\nSubject: ${email.subject}\n\n${email.text}\n---\n`);
    } else {
      logInfo({ msg: 'email not sent: no mail settings', type, to });
    }
    return false;
  }
  console.error(JSON.stringify({ level: 'error', msg: 'email failed', type, to, error: result.error }));
  try {
    await recordAudit({ ...context, eventType: 'EMAIL_FAILED', after: { type, to, error: result.error } });
  } catch {
    // Recording the failure must not fail the request.
  }
  return false;
}

/**
 * The single place that tells people what happened: one email per recipient, in their language.
 * Call it after the transaction commits. Never throws and waits a few seconds at most, so a mail
 * problem cannot undo or block the action; the result says whether every email went out.
 * @param {NotifyType} type
 * @param {NotifyPayload} payload
 * @param {AuditContext} [context] actor and entity for the EMAIL_FAILED audit event
 * @returns {Promise<boolean>}
 */
export async function notify(type, { to, ...data }, context = {}) {
  try {
    const results = await Promise.all(to.map((recipient) => deliver(type, recipient, data, context)));
    return results.length > 0 && results.every(Boolean);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'notify failed', type, error: error instanceof Error ? error.message : 'unknown' }));
    return false;
  }
}
