/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string | string[]>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

/**
 * A CSV file the browser downloads.
 * @param {import('node:http').ServerResponse} res
 * @param {string} fileName ASCII only
 * @param {string} body
 */
export function sendCsv(res, fileName, body) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {{ details?: unknown, headers?: Record<string, string | string[]> }} [extra]
 */
export function sendError(res, status, code, message, extra = {}) {
  const error = extra.details === undefined ? { code, message } : { code, message, details: extra.details };
  sendJson(res, status, { error }, extra.headers);
}
