/**
 * Platform administration.
 *
 * Privacy boundary: admins manage ACCOUNTS, not vault CONTENTS. Nothing here
 * reads item titles, references, notes or dates — only aggregate counts.
 * Admins cannot sign in as a user, read their items, or see password hashes.
 * Every mutating action is written to admin_audit in the same transaction.
 *
 * Role changes (promote/demote) are deliberately NOT exposed over HTTP; they are
 * done with `npm run admin:seed` (see scripts/seed-admin.js) by someone with
 * database/deploy access.
 */
import { query, withTransaction } from '../db/pool.js';
import { AppError, notFound, forbidden } from '../lib/errors.js';
import { newToken } from '../lib/tokens.js';
import { hashPassword } from './users.js';

const RESET_TTL_MINUTES = 60;

function toAdminUser(r) {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    status: r.disabled_at ? 'disabled' : r.locked_until && r.locked_until > new Date() ? 'locked' : 'active',
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    disabledAt: r.disabled_at,
    lockedUntil: r.locked_until && r.locked_until > new Date() ? r.locked_until : null,
    failedLogins: r.failed_logins,
    emailReminders: r.email_reminders,
    timezone: r.timezone,
    itemCount: r.item_count,
    activeSessions: r.session_count,
  };
}

const ADMIN_USER_SELECT = `
  SELECT u.id, u.email, u.display_name, u.role, u.created_at, u.last_login_at, u.disabled_at,
         u.locked_until, u.failed_logins, u.email_reminders, u.timezone,
         (SELECT count(*)::int FROM items i WHERE i.user_id = u.id AND i.deleted_at IS NULL) AS item_count,
         (SELECT count(*)::int FROM session s WHERE (s.sess->>'userId') = u.id::text AND s.expire > now()) AS session_count
  FROM users u`;

export async function platformStats() {
  const { rows } = await query(`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM users WHERE role = 'admin') AS admins,
      (SELECT count(*)::int FROM users WHERE disabled_at IS NOT NULL) AS disabled,
      (SELECT count(*)::int FROM users WHERE created_at > now() - interval '30 days') AS new_30d,
      (SELECT count(*)::int FROM users WHERE last_login_at > now() - interval '30 days') AS active_30d,
      (SELECT count(*)::int FROM items WHERE deleted_at IS NULL) AS items,
      (SELECT count(*)::int FROM reminder_log WHERE sent_at > now() - interval '30 days') AS reminders_30d`);
  const r = rows[0];
  return {
    users: r.users, admins: r.admins, disabled: r.disabled, newLast30Days: r.new_30d,
    activeLast30Days: r.active_30d, items: r.items, remindersLast30Days: r.reminders_30d,
  };
}

const SORTS = {
  created: 'u.created_at DESC',
  '-created': 'u.created_at ASC',
  email: 'u.email ASC',
  lastLogin: 'u.last_login_at DESC NULLS LAST',
};

export async function listUsers({ q, status, role, sort = 'created', page = 1, limit = 50 }) {
  const where = [];
  const values = [];
  if (q) {
    values.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(u.email ILIKE $${values.length} OR u.display_name ILIKE $${values.length})`);
  }
  if (role) {
    values.push(role);
    where.push(`u.role = $${values.length}`);
  }
  if (status === 'disabled') where.push('u.disabled_at IS NOT NULL');
  if (status === 'locked') where.push('u.disabled_at IS NULL AND u.locked_until > now()');
  if (status === 'active') where.push('u.disabled_at IS NULL AND (u.locked_until IS NULL OR u.locked_until <= now())');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [list, count] = await Promise.all([
    query(`${ADMIN_USER_SELECT} ${whereSql} ORDER BY ${SORTS[sort] || SORTS.created}
           LIMIT ${Number(limit)} OFFSET ${(Number(page) - 1) * Number(limit)}`, values),
    query(`SELECT count(*)::int AS total FROM users u ${whereSql}`, values),
  ]);
  const total = count.rows[0].total;
  return { users: list.rows.map(toAdminUser), meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

export async function getUser(id) {
  const { rows } = await query(`${ADMIN_USER_SELECT} WHERE u.id = $1`, [id]);
  if (!rows[0]) throw notFound('User not found');
  return toAdminUser(rows[0]);
}

export async function listAudit({ page = 1, limit = 50, targetUserId }) {
  const values = [];
  let where = '';
  if (targetUserId) {
    values.push(targetUserId);
    where = 'WHERE target_user_id = $1';
  }
  const { rows } = await query(
    `SELECT id, admin_email, action, target_user_id, target_email, ip, created_at FROM admin_audit ${where}
     ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${(Number(page) - 1) * Number(limit)}`,
    values,
  );
  return rows.map((r) => ({
    id: Number(r.id), adminEmail: r.admin_email, action: r.action, targetUserId: r.target_user_id,
    targetEmail: r.target_email, ip: r.ip, createdAt: r.created_at,
  }));
}

/**
 * Run an admin action on a target user in a transaction with an audit entry.
 * `guard` lists protections: 'notSelf' blocks acting on your own account.
 */
async function act(admin, targetId, action, ip, fn, { notSelf = false } = {}) {
  if (notSelf && admin.id === targetId) throw forbidden('You cannot do this to your own account');
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id, email, display_name, role, disabled_at FROM users WHERE id = $1 FOR UPDATE',
      [targetId],
    );
    const target = rows[0];
    if (!target) throw notFound('User not found');
    const result = await fn(client, target);
    await client.query(
      `INSERT INTO admin_audit (admin_id, admin_email, action, target_user_id, target_email, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [admin.id, admin.email, action, action === 'delete_user' ? null : target.id, target.email, ip || null],
    );
    return { target, result };
  });
}

const revokeSessions = (client, userId) => client.query(`DELETE FROM session WHERE (sess->>'userId') = $1`, [userId]);

/** Create a reset token for the target (replacing any outstanding one). Returns the raw token. */
export function createResetFor(admin, targetId, ip, action) {
  return act(admin, targetId, action, ip, async (client, target) => {
    if (target.disabled_at) throw new AppError(409, 'ACCOUNT_DISABLED', 'Enable the account before resetting its password');
    const { token, hash } = newToken();
    await client.query('DELETE FROM password_resets WHERE user_id = $1', [target.id]);
    await client.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [target.id, hash, RESET_TTL_MINUTES],
    );
    return token;
  });
}

export const unlockUser = (admin, id, ip) =>
  act(admin, id, 'unlock', ip, (c, t) => c.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [t.id]));

export const signOutEverywhere = (admin, id, ip) =>
  act(admin, id, 'revoke_sessions', ip, (c, t) => revokeSessions(c, t.id));

export const disableUser = (admin, id, ip) =>
  act(admin, id, 'disable', ip, async (c, t) => {
    if (t.disabled_at) throw new AppError(409, 'CONFLICT', 'Account is already disabled');
    await c.query('UPDATE users SET disabled_at = now(), updated_at = now() WHERE id = $1', [t.id]);
    await c.query('DELETE FROM password_resets WHERE user_id = $1', [t.id]);
    await revokeSessions(c, t.id);
  }, { notSelf: true });

export const enableUser = (admin, id, ip) =>
  act(admin, id, 'enable', ip, async (c, t) => {
    if (!t.disabled_at) throw new AppError(409, 'CONFLICT', 'Account is not disabled');
    await c.query('UPDATE users SET disabled_at = NULL, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [t.id]);
  });

export const deleteUser = (admin, id, confirmEmail, ip) =>
  act(admin, id, 'delete_user', ip, async (c, t) => {
    if (t.role === 'admin') throw forbidden('Demote an administrator (npm run admin:seed -- --demote) before deleting it');
    if (confirmEmail !== t.email) throw new AppError(422, 'VALIDATION_ERROR', 'Type the user\'s email address to confirm');
    await revokeSessions(c, t.id);
    await c.query('DELETE FROM users WHERE id = $1', [t.id]);
  }, { notSelf: true });

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

