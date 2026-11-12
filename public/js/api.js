/** Thin JSON API client: same-origin cookies, CSRF header, consistent errors. */

let csrfToken = null;
export const setCsrfToken = (t) => { csrfToken = t || null; };

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'OFFLINE', "You're offline. Check your connection and try again.");
  }

  if (res.status === 204) return null;
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok || !json?.success) {
    const e = json?.error || {};
    const err = new ApiError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status})`, e.details);
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      window.dispatchEvent(new CustomEvent('vx:unauthorized'));
    }
    throw err;
  }
  return { data: json.data, meta: json.meta, offline: res.headers.get('X-From-Cache') === '1' };
}
