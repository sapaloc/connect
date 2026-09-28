export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {{ details?: unknown, headers?: Record<string, string> }} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = extra.details;
    this.headers = extra.headers ?? {};
  }
}

/** @param {number} retryAfterSeconds */
export function rateLimited(retryAfterSeconds) {
  return new HttpError(429, 'RATE_LIMITED', 'Too many attempts, try again later', {
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}
