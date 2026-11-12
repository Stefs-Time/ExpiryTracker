import crypto from 'node:crypto';
import { config } from '../config.js';
import { forbidden, unauthorized, AppError } from '../lib/errors.js';
import { safeEqual } from '../lib/tokens.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence for the JSON API (layered):
 * 1. Session cookie is SameSite=Lax + HttpOnly.
 * 2. Unsafe requests must be JSON, or a raw JPEG for photo uploads. Neither type can be sent
 *    cross-site by an HTML form or without a CORS preflight (which this API never grants).
 * 3. Origin / Sec-Fetch-Site must indicate a same-origin request.
 * 4. Authenticated unsafe requests must carry the per-session X-CSRF-Token (synchronizer token).
 */
export function csrfProtection(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > 0 && !req.is('application/json') && !req.is('image/jpeg')) {
    return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json (or image/jpeg for photos)'));
  }

  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return next(forbidden('Cross-site request blocked'));

  const origin = req.headers.origin;
  if (origin) {
    const expected = `${req.protocol}://${req.get('host')}`;
    if (origin !== expected && origin !== config.appUrl) return next(forbidden('Origin not allowed'));
  }

  if (req.session?.userId) {
    const token = req.get('x-csrf-token');
    if (!token || !req.session.csrfToken || !safeEqual(token, req.session.csrfToken)) {
      return next(forbidden('Invalid or missing CSRF token'));
    }
  }
  return next();
}

export function ensureCsrfToken(session) {
  if (!session.csrfToken) session.csrfToken = crypto.randomBytes(24).toString('base64url');
  return session.csrfToken;
}

export function requireAuth(req, res, next) {
  if (!req.session?.userId) return next(unauthorized());
  return next();
}

/** Prevent caching of personal API responses by browsers and intermediaries. */
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}
