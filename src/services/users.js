import argon2 from 'argon2';
import { query, withTransaction } from '../db/pool.js';
import { conflict, unauthorized, AppError } from '../lib/errors.js';
import { newToken, hashToken } from '../lib/tokens.js';

// OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1).
const HASH_OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MINUTES = 60;

let dummyHash; // used to equalise timing when the email does not exist
async function getDummyHash() {
  dummyHash ??= await argon2.hash('not-a-real-password-placeholder', HASH_OPTS);
  return dummyHash;
}

export const hashPassword = (pw) => argon2.hash(pw, HASH_OPTS);

const USER_COLUMNS = `id, email, display_name, timezone, critical_days, warning_days, email_reminders,
  (calendar_token_hash IS NOT NULL) AS has_calendar_feed, role, disabled_at, ai_scan_consent_at, password_changed_at, created_at`;

export function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    timezone: row.timezone,
    criticalDays: row.critical_days,
    warningDays: row.warning_days,
    emailReminders: row.email_reminders,
    hasCalendarFeed: row.has_calendar_feed,
    isAdmin: row.role === 'admin',
    aiScanConsent: Boolean(row.ai_scan_consent_at),
    createdAt: row.created_at,
  };
}

export async function findById(id) {
  const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function createUser({ email, password, displayName, timezone }) {
  const passwordHash = await hashPassword(password);
  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, display_name, timezone, last_login_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING ${USER_COLUMNS}`,
      [email, passwordHash, displayName, timezone],
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw conflict('An account with this email already exists');
    throw err;
  }
}

/** Verify credentials with per-account lockout after repeated failures. */
export async function authenticate(email, password) {
  const { rows } = await query(
    'SELECT id, password_hash, failed_logins, locked_until, disabled_at FROM users WHERE email = $1',
    [email],
  );
  const user = rows[0];
  if (!user) {
    await argon2.verify(await getDummyHash(), password).catch(() => false);
    throw unauthorized('Incorrect email or password');
  }
  if (user.locked_until && user.locked_until > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes or reset your password.');
  }
  const ok = await argon2.verify(user.password_hash, password).catch(() => false);
  if (!ok) {
    await query(
      `UPDATE users SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE NULL END
       WHERE id = $1`,
      [user.id, MAX_FAILED, LOCK_MINUTES],
    );
    throw unauthorized('Incorrect email or password');
  }
  // Checked only after a correct password, so disabled status is not revealed to guessers.
  if (user.disabled_at) {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled. Contact support.');
  }
  if (argon2.needsRehash(user.password_hash, HASH_OPTS)) {
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(password)]);
  }
  await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
  return findById(user.id);
}

export async function verifyPassword(userId, password) {
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0]) return false;
  return argon2.verify(rows[0].password_hash, password).catch(() => false);
}

/**
 * Set a new password, bump password_changed_at and remove every stored session
 * for the user (the caller re-creates the current one if appropriate).
 */
export async function setPassword(userId, password, client = { query }) {
  const hash = await hashPassword(password);
  const { rows } = await client.query(
    `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0,
       locked_until = NULL, updated_at = now() WHERE id = $1 RETURNING password_changed_at`,
    [userId, hash],
  );
  await client.query(`DELETE FROM session WHERE (sess->>'userId') = $1`, [userId]);
  return rows[0]?.password_changed_at;
}

export async function updateSettings(userId, patch) {
  const map = {
    displayName: 'display_name',
    timezone: 'timezone',
    criticalDays: 'critical_days',
    warningDays: 'warning_days',
    emailReminders: 'email_reminders',
  };
  const sets = [];
  const values = [userId];
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      sets.push(`${col} = $${values.length}`);
    }
  }
  if (sets.length) {
    try {
      await query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values);
    } catch (err) {
      if (err.code === '23514') {
        throw new AppError(422, 'VALIDATION_ERROR', 'The warning window must be longer than the critical window');
      }
      throw err;
    }
  }
  return findById(userId);
}

export async function deleteUser(userId) {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM session WHERE (sess->>'userId') = $1`, [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
  });
}

/** Create a single-use password reset token. Returns null when the email is unknown. */
export async function createPasswordReset(email) {
  const { rows } = await query('SELECT id, display_name, email FROM users WHERE email = $1 AND disabled_at IS NULL', [email]);
  const user = rows[0];
  if (!user) return null;
  const { token, hash } = newToken();
  await withTransaction(async (client) => {
    // Only the most recent link is valid.
    await client.query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);
    await client.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [user.id, hash, RESET_TTL_MINUTES],
    );
  });
  return { token, user };
}

export async function consumePasswordReset(token, newPassword) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id FROM password_resets
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
         AND user_id IN (SELECT id FROM users WHERE disabled_at IS NULL)
       FOR UPDATE`,
      [hashToken(token)],
    );
    if (!rows[0]) throw new AppError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired');
    await client.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [rows[0].id]);
    await setPassword(rows[0].user_id, newPassword, client);
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [rows[0].user_id]);
    return rows[0].user_id;
  });
}

/** Issue a new private calendar-feed token (the old one stops working). Returns the raw token once. */
export async function rotateCalendarToken(userId) {
  const { token, hash } = newToken();
  await query('UPDATE users SET calendar_token_hash = $2, updated_at = now() WHERE id = $1', [userId, hash]);
  return token;
}

export async function revokeCalendarToken(userId) {
  await query('UPDATE users SET calendar_token_hash = NULL, updated_at = now() WHERE id = $1', [userId]);
}

export async function findByCalendarToken(token) {
  const { rows } = await query(
    `SELECT ${USER_COLUMNS} FROM users WHERE calendar_token_hash = $1 AND disabled_at IS NULL`,
    [hashToken(token)],
  );
  return rows[0] || null;
}

/** Record (or withdraw) consent to send photos to the AI provider for reading. */
export async function setScanConsent(userId, consent) {
  await query(
    `UPDATE users SET ai_scan_consent_at = ${'CASE WHEN $2 THEN now() ELSE NULL END'}, updated_at = now() WHERE id = $1`,
    [userId, consent],
  );
  return findById(userId);
}
