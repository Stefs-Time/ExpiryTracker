/**
 * Platform administration ("back office").
 *
 * Privacy boundary: admins manage ACCOUNTS, not vault CONTENTS. Nothing here
 * reads item titles, references, notes, dates or photos — only aggregate counts.
 * Admins cannot sign in as a user, read their items, or see password hashes.
 * Every mutating action is written to admin_audit in the same transaction.
 *
 * Role changes (promote/demote) are deliberately NOT exposed over HTTP; they are
 * done with `npm run admin:seed` (see scripts/seed-admin.js) by someone with
 * database/deploy access.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { AppError, notFound, forbidden, conflict } from '../lib/errors.js';
import { newToken } from '../lib/tokens.js';
import { hashPassword } from './users.js';
import { mailEnabled } from './mailer.js';
import { reminderJob } from './reminders.js';
import { maintenanceJob } from './maintenance.js';

const RESET_TTL_MINUTES = 60;
export const INVITE_TTL_HOURS = 72;
const EXPORT_MAX_ROWS = 5000;
const APP_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export const AUDIT_ACTIONS = Object.freeze([
  'password_reset_email', 'password_reset_link', 'unlock', 'revoke_sessions',
  'disable', 'enable', 'delete_user', 'invite_email', 'invite_link',
]);

function statusOf(r) {
  if (r.disabled_at) return 'disabled';
  if (r.locked_until && r.locked_until > new Date()) return 'locked';
  if (r.invited_at && !r.last_login_at) return 'invited';
  return 'active';
}

function toAdminUser(r) {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    status: statusOf(r),
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    invitedAt: r.invited_at,
    disabledAt: r.disabled_at,
    lockedUntil: r.locked_until && r.locked_until > new Date() ? r.locked_until : null,
    failedLogins: r.failed_logins,
    emailReminders: r.email_reminders,
    timezone: r.timezone,
    itemCount: r.item_count,
    photoCount: r.photo_count,
    activeSessions: r.session_count,
    noteCount: r.note_count,
  };
}

// Counts only: never item or photo contents.
const ADMIN_USER_SELECT = `
  SELECT u.id, u.email, u.display_name, u.role, u.created_at, u.last_login_at, u.invited_at, u.disabled_at,
         u.locked_until, u.failed_logins, u.email_reminders, u.timezone,
         (SELECT count(*)::int FROM items i WHERE i.user_id = u.id AND i.deleted_at IS NULL) AS item_count,
         (SELECT count(*)::int FROM item_attachments a WHERE a.user_id = u.id) AS photo_count,
         (SELECT count(*)::int FROM session s WHERE (s.sess->>'userId') = u.id::text AND s.expire > now()) AS session_count,
         (SELECT count(*)::int FROM admin_notes n WHERE n.user_id = u.id) AS note_count
  FROM users u`;

const STATUS_SQL = {
  disabled: 'u.disabled_at IS NOT NULL',
  locked: 'u.disabled_at IS NULL AND u.locked_until > now()',
  invited: 'u.disabled_at IS NULL AND u.invited_at IS NOT NULL AND u.last_login_at IS NULL AND (u.locked_until IS NULL OR u.locked_until <= now())',
  active: `u.disabled_at IS NULL AND (u.locked_until IS NULL OR u.locked_until <= now())
           AND NOT (u.invited_at IS NOT NULL AND u.last_login_at IS NULL)`,
};

export async function platformStats() {
  const { rows } = await query(`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM users WHERE role = 'admin') AS admins,
      (SELECT count(*)::int FROM users u WHERE ${STATUS_SQL.disabled}) AS disabled,
      (SELECT count(*)::int FROM users u WHERE ${STATUS_SQL.locked}) AS locked,
      (SELECT count(*)::int FROM users u WHERE ${STATUS_SQL.invited}) AS invited,
      (SELECT count(*)::int FROM users WHERE created_at > now() - interval '30 days') AS new_30d,
      (SELECT count(*)::int FROM users WHERE last_login_at > now() - interval '30 days') AS active_30d,
      (SELECT count(*)::int FROM items WHERE deleted_at IS NULL) AS items,
      (SELECT count(*)::int FROM reminder_log WHERE sent_at > now() - interval '30 days') AS reminders_30d`);
  const r = rows[0];
  return {
    users: r.users, admins: r.admins, disabled: r.disabled, locked: r.locked, invited: r.invited,
    newLast30Days: r.new_30d, activeLast30Days: r.active_30d, items: r.items, remindersLast30Days: r.reminders_30d,
  };
}

const SORTS = {
  created: 'u.created_at DESC',
  '-created': 'u.created_at ASC',
  email: 'u.email ASC',
  '-email': 'u.email DESC',
  name: 'lower(u.display_name) ASC, u.email ASC',
  '-name': 'lower(u.display_name) DESC, u.email ASC',
  lastLogin: 'u.last_login_at DESC NULLS LAST',
  '-lastLogin': 'u.last_login_at ASC NULLS FIRST',
};

const likeParam = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

function userFilters({ q, status, role }) {
  const where = [];
  const values = [];
  if (q) {
    values.push(likeParam(q));
    where.push(`(u.email ILIKE $${values.length} OR u.display_name ILIKE $${values.length})`);
  }
  if (role) {
    values.push(role);
    where.push(`u.role = $${values.length}`);
  }
  if (status) where.push(STATUS_SQL[status]);
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

export async function listUsers({ q, status, role, sort = 'created', page = 1, limit = 50 }) {
  const { whereSql, values } = userFilters({ q, status, role });
  const [list, count] = await Promise.all([
    query(`${ADMIN_USER_SELECT} ${whereSql} ORDER BY ${SORTS[sort] || SORTS.created}
           LIMIT ${Number(limit)} OFFSET ${(Number(page) - 1) * Number(limit)}`, values),
    query(`SELECT count(*)::int AS total FROM users u ${whereSql}`, values),
  ]);
  const total = count.rows[0].total;
  return { users: list.rows.map(toAdminUser), meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

/** Rows for the users CSV export (same filters as the list, capped). */
export async function exportUsers(filters) {
  const { whereSql, values } = userFilters(filters);
  const { rows } = await query(
    `${ADMIN_USER_SELECT} ${whereSql} ORDER BY ${SORTS[filters.sort] || SORTS.created} LIMIT ${EXPORT_MAX_ROWS}`,
    values,
  );
  return rows.map(toAdminUser);
}

export async function getUser(id) {
  const { rows } = await query(`${ADMIN_USER_SELECT} WHERE u.id = $1`, [id]);
  if (!rows[0]) throw notFound('User not found');
  return toAdminUser(rows[0]);
}

/** Everything the detail panel needs in one call: account, support notes, recent admin activity. */
export async function getUserDetail(id) {
  const [user, notes, activity] = await Promise.all([
    getUser(id),
    listNotes(id),
    listAudit({ targetUserId: id, limit: 20 }),
  ]);
  return { user, notes, activity: activity.entries };
}

// ---------- Audit ----------

const toAudit = (r) => ({
  id: Number(r.id), adminEmail: r.admin_email, action: r.action, targetUserId: r.target_user_id,
  targetEmail: r.target_email, reason: r.reason, ip: r.ip, createdAt: r.created_at,
});

function auditFilters({ targetUserId, action, q }) {
  const where = [];
  const values = [];
  if (targetUserId) {
    values.push(targetUserId);
    where.push(`target_user_id = $${values.length}`);
  }
  if (action) {
    values.push(action);
    where.push(`action = $${values.length}`);
  }
  if (q) {
    values.push(likeParam(q));
    where.push(`(target_email ILIKE $${values.length} OR admin_email ILIKE $${values.length} OR reason ILIKE $${values.length})`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

export async function listAudit({ page = 1, limit = 50, ...filters }) {
  const { whereSql, values } = auditFilters(filters);
  const [list, count] = await Promise.all([
    query(
      `SELECT id, admin_email, action, target_user_id, target_email, reason, ip, created_at FROM admin_audit ${whereSql}
       ORDER BY created_at DESC, id DESC LIMIT ${Number(limit)} OFFSET ${(Number(page) - 1) * Number(limit)}`,
      values,
    ),
    query(`SELECT count(*)::int AS total FROM admin_audit ${whereSql}`, values),
  ]);
  const total = count.rows[0].total;
  return { entries: list.rows.map(toAudit), meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

export async function exportAudit(filters) {
  const { whereSql, values } = auditFilters(filters);
  const { rows } = await query(
    `SELECT id, admin_email, action, target_user_id, target_email, reason, ip, created_at FROM admin_audit ${whereSql}
     ORDER BY created_at DESC, id DESC LIMIT ${EXPORT_MAX_ROWS}`,
    values,
  );
  return rows.map(toAudit);
}

/**
 * Run an admin action on a target user in a transaction with an audit entry.
 * `notSelf` blocks acting on your own account; `reason` is an optional internal note on the entry.
 */
async function act(admin, targetId, action, ip, fn, { notSelf = false, reason = null } = {}) {
  if (notSelf && admin.id === targetId) throw forbidden('You cannot do this to your own account');
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id, email, display_name, role, disabled_at FROM users WHERE id = $1 FOR UPDATE',
      [targetId],
    );
    const target = rows[0];
    if (!target) throw notFound('User not found');
    const result = await fn(client, target);
    await audit(client, admin, action, action === 'delete_user' ? null : target.id, target.email, ip, reason);
    return { target, result };
  });
}

const audit = (client, admin, action, targetId, targetEmail, ip, reason = null) =>
  client.query(
    `INSERT INTO admin_audit (admin_id, admin_email, action, target_user_id, target_email, ip, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [admin.id, admin.email, action, targetId, targetEmail, ip || null, reason || null],
  );

const revokeSessions = (client, userId) => client.query(`DELETE FROM session WHERE (sess->>'userId') = $1`, [userId]);

async function insertResetToken(client, userId, ttlMinutes) {
  const { token, hash } = newToken();
  await client.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
  await client.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [userId, hash, ttlMinutes],
  );
  return token;
}

/** Create a reset token for the target (replacing any outstanding one). Returns the raw token. */
export function createResetFor(admin, targetId, ip, action) {
  return act(admin, targetId, action, ip, async (client, target) => {
    if (target.disabled_at) throw new AppError(409, 'ACCOUNT_DISABLED', 'Enable the account before resetting its password');
    return insertResetToken(client, target.id, RESET_TTL_MINUTES);
  });
}

/**
 * Invite a user: creates the account with an unusable random password and a
 * set-password token valid for INVITE_TTL_HOURS. The user chooses their own password.
 * @param {'invite_email' | 'invite_link'} action  how the link reaches the user (for the audit trail)
 */
export async function inviteUser(admin, { email, displayName }, ip, action) {
  const unusable = await hashPassword(crypto.randomBytes(32).toString('base64url'));
  return withTransaction(async (client) => {
    let user;
    try {
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, display_name, invited_at) VALUES ($1, $2, $3, now())
         RETURNING id, email, display_name`,
        [email, unusable, displayName],
      );
      user = rows[0];
    } catch (err) {
      if (err.code === '23505') throw conflict('An account with this email already exists');
      throw err;
    }
    const token = await insertResetToken(client, user.id, INVITE_TTL_HOURS * 60);
    await audit(client, admin, action, user.id, user.email, ip);
    return { user, token };
  });
}

export const unlockUser = (admin, id, ip) =>
  act(admin, id, 'unlock', ip, (c, t) => c.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [t.id]));

export const signOutEverywhere = (admin, id, ip) =>
  act(admin, id, 'revoke_sessions', ip, (c, t) => revokeSessions(c, t.id));

export const disableUser = (admin, id, ip, reason) =>
  act(admin, id, 'disable', ip, async (c, t) => {
    if (t.disabled_at) throw new AppError(409, 'CONFLICT', 'Account is already disabled');
    await c.query('UPDATE users SET disabled_at = now(), updated_at = now() WHERE id = $1', [t.id]);
    await c.query('DELETE FROM password_resets WHERE user_id = $1', [t.id]);
    await revokeSessions(c, t.id);
  }, { notSelf: true, reason });

export const enableUser = (admin, id, ip) =>
  act(admin, id, 'enable', ip, async (c, t) => {
    if (!t.disabled_at) throw new AppError(409, 'CONFLICT', 'Account is not disabled');
    await c.query('UPDATE users SET disabled_at = NULL, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [t.id]);
  });

export const deleteUser = (admin, id, confirmEmail, ip, reason) =>
  act(admin, id, 'delete_user', ip, async (c, t) => {
    if (t.role === 'admin') throw forbidden('Demote an administrator (npm run admin:seed -- --demote) before deleting it');
    if (confirmEmail !== t.email) throw new AppError(422, 'VALIDATION_ERROR', 'Type the user\'s email address to confirm');
    await revokeSessions(c, t.id);
    await c.query('DELETE FROM users WHERE id = $1', [t.id]);
  }, { notSelf: true, reason });

// ---------- Support notes (internal; never shown to the user) ----------

const toNote = (r) => ({ id: r.id, adminEmail: r.admin_email, body: r.body, createdAt: r.created_at });

export async function listNotes(userId) {
  const { rows } = await query(
    'SELECT id, admin_email, body, created_at FROM admin_notes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
    [userId],
  );
  return rows.map(toNote);
}

export async function addNote(admin, userId, body) {
  try {
    const { rows } = await query(
      `INSERT INTO admin_notes (user_id, admin_id, admin_email, body) VALUES ($1, $2, $3, $4)
       RETURNING id, admin_email, body, created_at`,
      [userId, admin.id, admin.email, body],
    );
    return toNote(rows[0]);
  } catch (err) {
    if (err.code === '23503') throw notFound('User not found');
    throw err;
  }
}

export async function deleteNote(userId, noteId) {
  const { rowCount } = await query('DELETE FROM admin_notes WHERE id = $1 AND user_id = $2', [noteId, userId]);
  if (!rowCount) throw notFound('Note not found');
}

// ---------- System status ----------

/** Configuration and job health for the back office. Flags and counts only — never secrets. */
export async function systemStatus() {
  const started = Date.now();
  let dbOk = true;
  let photos = { photos: 0, bytes: 0 };
  try {
    const { rows } = await query('SELECT count(*)::int AS photos, coalesce(sum(byte_size), 0)::bigint AS bytes FROM item_attachments');
    photos = { photos: rows[0].photos, bytes: Number(rows[0].bytes) };
  } catch {
    dbOk = false;
  }
  const dbMs = Date.now() - started;
  const mail = mailEnabled();

  const warnings = [];
  if (!mail) warnings.push('Email (SMTP) is not configured: reminders and emailed password resets are off, and reset/invite links are shown to admins instead.');
  if (!config.isProd) warnings.push(`The app is running in ${config.env} mode, not production.`);
  if (config.bootstrapAdmin.password) warnings.push('ADMIN_PASSWORD is still set in the environment. Remove it now that the admin account exists.');
  if (!config.attachmentsEnabled) warnings.push('Document photo storage is off (FILE_ENCRYPTION_KEY is not set).');
  if (!config.scanEnabled) warnings.push('AI photo scanning is off (GROQ_API_KEY is not set).');
  if (reminderJob.lastError) warnings.push(`The last reminder run failed: ${reminderJob.lastError}`);
  if (maintenanceJob.lastError) warnings.push(`The last maintenance run failed: ${maintenanceJob.lastError}`);

  return {
    version: APP_VERSION,
    environment: config.env,
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    database: { ok: dbOk, latencyMs: dbMs },
    features: {
      signupEnabled: config.signupEnabled,
      mailConfigured: mail,
      remindersRunning: reminderJob.running,
      attachmentsEnabled: config.attachmentsEnabled,
      scanEnabled: config.scanEnabled,
      scanModel: config.scanEnabled ? config.groq.model : null,
    },
    jobs: {
      reminders: { lastRunAt: reminderJob.lastRunAt, lastSent: reminderJob.lastSent, lastError: reminderJob.lastError },
      maintenance: { lastRunAt: maintenanceJob.lastRunAt, lastError: maintenanceJob.lastError },
    },
    photoStorage: photos,
    warnings,
  };
}

/**
 * Create or promote a platform admin. Used by the seed script and the optional
 * boot-time bootstrap. Idempotent. Returns { action: 'created' | 'promoted' | 'unchanged' | 'password_updated' }.
 */
export async function seedAdmin({ email, password, displayName = 'Platform Admin', resetPassword = false, allowPromote = true }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, role FROM users WHERE email = $1 FOR UPDATE', [email]);
    if (!rows[0]) {
      if (!password) throw new Error('A password is required to create a new admin account');
      await client.query(
        `INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, $2, $3, 'admin')`,
        [email, await hashPassword(password), displayName],
      );
      return { action: 'created' };
    }
    const user = rows[0];
    let action = 'unchanged';
    if (user.role !== 'admin') {
      // Boot-time bootstrap passes allowPromote=false: with public sign-up, someone could
      // register ADMIN_EMAIL first and would otherwise be promoted on the next deploy.
      if (!allowPromote) return { action: 'refused_existing_user' };
      await client.query(`UPDATE users SET role = 'admin', disabled_at = NULL, updated_at = now() WHERE id = $1`, [user.id]);
      action = 'promoted';
    }
    if (resetPassword && password) {
      await client.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL,
           disabled_at = NULL, updated_at = now() WHERE id = $1`,
        [user.id, await hashPassword(password)],
      );
      await revokeSessions(client, user.id);
      action = action === 'promoted' ? 'promoted' : 'password_updated';
    }
    return { action };
  });
}

/** Demote an admin to a normal user. Never leaves the platform without an active admin. */
export async function demoteAdmin(email) {
  return withTransaction(async (client) => {
    // Lock all admin rows so two concurrent demotions cannot both pass the check.
    const { rows } = await client.query(`SELECT id, email, disabled_at FROM users WHERE role = 'admin' FOR UPDATE`);
    const target = rows.find((r) => r.email === email);
    if (!target) return false;
    const otherActive = rows.filter((r) => r.email !== email && !r.disabled_at).length;
    if (otherActive === 0) throw new Error('Refusing to demote the last active admin');
    await client.query(`UPDATE users SET role = 'user', updated_at = now() WHERE id = $1`, [target.id]);
    await client.query(`DELETE FROM session WHERE (sess->>'userId') = $1`, [target.id]);
    return true;
  });
}

