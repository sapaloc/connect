import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

export const SEND_TIMEOUT_MS = 8000;

/**
 * @typedef {{ to: string, subject: string, text: string, html: string }} Mail
 * @typedef {{ sendMail(message: Mail & { from: string }): Promise<unknown> }} Transport
 * @typedef {{ sent: true } | { sent: false, reason: 'NOT_CONFIGURED' | 'FAILED', error?: string }} SendResult
 */

/** @type {Transport | null} */
let transport = null;
/** @type {{ transport: Transport | null, timeoutMs: number } | null} */
let testOverride = null;

/** Sending needs a provider (`MAIL_SERVICE` or `SMTP_HOST`) and a sender address. */
export function mailConfigured() {
  return Boolean((env.mailService || env.smtpHost) && env.mailFrom);
}

/** @returns {Transport} */
function createTransport() {
  const auth = env.mailUser ? { user: env.mailUser, pass: env.mailPass } : undefined;
  const timeouts = { connectionTimeout: SEND_TIMEOUT_MS, greetingTimeout: SEND_TIMEOUT_MS, socketTimeout: SEND_TIMEOUT_MS };
  if (env.mailService) return nodemailer.createTransport({ service: env.mailService, auth, ...timeouts });
  return nodemailer.createTransport({ host: env.smtpHost, port: env.smtpPort, secure: env.smtpPort === 465, auth, ...timeouts });
}

/**
 * Tests only: `transport` replaces the SMTP one (`null` = no mail settings); `undefined` restores env.
 * @param {Transport | null | undefined} fake
 * @param {{ timeoutMs?: number }} [options]
 */
export function useTestTransport(fake, { timeoutMs = SEND_TIMEOUT_MS } = {}) {
  if (env.appEnv !== 'test') throw new Error('useTestTransport is for APP_ENV=test only');
  testOverride = fake === undefined ? null : { transport: fake, timeoutMs };
}

/** Provider messages can echo the login; keep credentials out of logs and audit. @param {unknown} error */
export function safeErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [env.mailPass, env.mailUser]) {
    if (secret) message = message.split(secret).join('***');
  }
  return message.slice(0, 300);
}

/**
 * Sends one email, waiting at most a few seconds (serverless functions may stop after the response).
 * Never throws.
 * @param {Mail} mail
 * @returns {Promise<SendResult>}
 */
export async function sendMail(mail) {
  const active = testOverride
    ? testOverride.transport
    : mailConfigured()
      ? (transport ??= createTransport())
      : null;
  if (!active) return { sent: false, reason: 'NOT_CONFIGURED' };
  const timeoutMs = testOverride?.timeoutMs ?? SEND_TIMEOUT_MS;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    await Promise.race([
      active.sendMail({ from: env.mailFrom || 'Connect <no-reply@connect.local>', ...mail }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Email not sent within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: 'FAILED', error: safeErrorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}
