export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {any} [details]
   * @param {number} [retryAfter]
   */
  constructor(status, code, message, details, retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

/** Fired on window when the server no longer accepts the session (expired, revoked, account blocked). */
export const SESSION_ENDED = 'connect:session-ended';

/**
 * @param {'GET' | 'POST'} method
 * @param {string} path
 * @param {unknown} [body]
 */
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': body instanceof Blob ? 'application/octet-stream' : 'application/json' }),
      },
      body: body === undefined || body instanceof Blob ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw failure(res, data);
  return data;
}

/**
 * @param {Response} res
 * @param {any} data parsed JSON error body
 */
function failure(res, data) {
  if (data?.error?.code === 'UNAUTHENTICATED') window.dispatchEvent(new Event(SESSION_ENDED));
  return new ApiError(
    res.status,
    data?.error?.code ?? 'UNKNOWN',
    data?.error?.message ?? res.statusText,
    data?.error?.details,
    Number(res.headers.get('Retry-After')) || 0,
  );
}

/**
 * A file from the API (e.g. a CSV) with the name the server gives it; errors as for `api`.
 * @param {string} path
 * @returns {Promise<{ blob: Blob, fileName: string }>}
 */
export async function apiFile(path) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  if (!res.ok) throw failure(res, await res.json().catch(() => null));
  const fileName = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'download';
  return { blob: await res.blob(), fileName };
}

/**
 * @typedef {{ roleAssignmentId: string, role: string, scopeType: string, tenantId: string | null, tenantName: string | null }} RoleOption
 * @typedef {{
 *   user: { id: string, email: string, displayName: string, preferredLanguage: 'en' | 'vi' },
 *   mustChangePassword: boolean,
 *   activeRole: RoleOption | null,
 *   roles: RoleOption[],
 *   permissions: string[],
 *   landing: string | null,
 *   needsRoleSelection: boolean,
 *   partnerProfile: boolean,
 * }} Profile
 */

/** @returns {Promise<Profile | null>} */
export async function fetchProfile() {
  try {
    return await api('GET', '/api/v1/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}
