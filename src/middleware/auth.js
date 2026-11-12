import { findById } from '../services/users.js';
import { unauthorized } from '../lib/errors.js';
import { ensureCsrfToken } from './security.js';

/** Promisified session helpers. */
export const regenerate = (req) => new Promise((ok, fail) => req.session.regenerate((e) => (e ? fail(e) : ok())));
export const saveSession = (req) => new Promise((ok, fail) => req.session.save((e) => (e ? fail(e) : ok())));
export const destroySession = (req) => new Promise((ok) => req.session.destroy(() => ok()));

/**
 * Start an authenticated session; regenerating the id prevents session fixation.
 * `user` must be a fresh row (its password_changed_at pins the session to the current password).
 */
export async function logIn(req, user) {
  await regenerate(req);
  req.session.userId = user.id;
  req.session.pwdAt = new Date(user.password_changed_at).toISOString();
  const csrfToken = ensureCsrfToken(req.session);
  await saveSession(req);
  return csrfToken;
}

/**
 * Require a logged-in user and load it as req.user. Sessions created before the
 * last password change are rejected (defence in depth; such sessions are also deleted).
 */
export async function requireUser(req, res, next) {
  try {
    const userId = req.session?.userId;
    if (!userId) throw unauthorized();
    const user = await findById(userId);
    if (!user || new Date(user.password_changed_at).toISOString() !== req.session.pwdAt) {
      await destroySession(req);
      throw unauthorized('Your session has ended. Please sign in again.');
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
