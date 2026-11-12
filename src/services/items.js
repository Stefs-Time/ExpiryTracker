import { query, withTransaction } from '../db/pool.js';
import { notFound, AppError } from '../lib/errors.js';
import { suggestRenewalDate } from '../../public/js/shared/expiry.js';

const COLUMNS = `id, title, category, ref, expiry_date, cycle_months, lead_days, note, created_at, updated_at`;

export function toItem(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    ref: row.ref,
    expiryDate: row.expiry_date,
    cycleMonths: row.cycle_months,
    leadDays: row.lead_days,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SORTS = {
  expiry: 'expiry_date ASC, title ASC',
  '-expiry': 'expiry_date DESC, title ASC',
  title: 'title ASC, expiry_date ASC',
  created: 'created_at DESC',
};

/**
 * List a user's items with optional search, category and status filters.
 * Status is computed against `today` (the user's local date) and their thresholds.
 */
export async function listItems(userId, { q, category, status, sort = 'expiry', page = 1, limit = 100 }, ctx) {
  const where = ['user_id = $1'];
  const values = [userId];
  const add = (sql, v) => {
    values.push(v);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };

  if (q) add(`(title ILIKE ? OR ref ILIKE ? OR note ILIKE ? OR category ILIKE ?)`, `%${q.replace(/[\\%_]/g, '\\$&')}%`);
  if (category) add('category = ?', category);
  if (status) {
    values.push(ctx.today);
    const days = `(expiry_date - $${values.length}::date)`;
    const param = (v) => {
      values.push(v);
      return `$${values.length}::int`;
    };
    if (status === 'critical') where.push(`${days} <= ${param(ctx.criticalDays)}`);
    if (status === 'soon') where.push(`${days} > ${param(ctx.criticalDays)} AND ${days} <= ${param(ctx.warningDays)}`);
    if (status === 'valid') where.push(`${days} > ${param(ctx.warningDays)}`);
  }

  const whereSql = where.join(' AND ');
  const offset = (page - 1) * limit;
  const [list, count] = await Promise.all([
    query(
      `SELECT ${COLUMNS} FROM items WHERE ${whereSql} ORDER BY ${SORTS[sort] || SORTS.expiry}
       LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      values,
    ),
    query(`SELECT count(*)::int AS total FROM items WHERE ${whereSql}`, values),
  ]);
  const total = count.rows[0].total;
  return {
    items: list.rows.map(toItem),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/** All items for a user (reports, exports, calendar). Bounded by MAX_ITEMS_PER_USER. */
export async function allItems(userId) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM items WHERE user_id = $1 ORDER BY expiry_date, title`, [userId]);
  return rows.map(toItem);
}

export const MAX_ITEMS_PER_USER = 1000;

export async function getItem(userId, id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM items WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) throw notFound('Item not found');
  return toItem(rows[0]);
}

export async function createItem(userId, data) {
  const { rows: countRows } = await query('SELECT count(*)::int AS n FROM items WHERE user_id = $1', [userId]);
  if (countRows[0].n >= MAX_ITEMS_PER_USER) {
    throw new AppError(409, 'LIMIT_REACHED', `You can track up to ${MAX_ITEMS_PER_USER} items`);
  }
  const { rows } = await query(
    `INSERT INTO items (user_id, title, category, ref, expiry_date, cycle_months, lead_days, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
    [userId, data.title, data.category, data.ref, data.expiryDate, data.cycleMonths, data.leadDays, data.note],
  );
  return toItem(rows[0]);
}

export async function updateItem(userId, id, patch) {
  const map = {
    title: 'title',
    category: 'category',
    ref: 'ref',
    expiryDate: 'expiry_date',
    cycleMonths: 'cycle_months',
    leadDays: 'lead_days',
    note: 'note',
  };
  const sets = [];
  const values = [id, userId];
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      sets.push(`${col} = $${values.length}`);
    }
  }
  if (!sets.length) return getItem(userId, id);
  const { rows } = await query(
    `UPDATE items SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
    values,
  );
  if (!rows[0]) throw notFound('Item not found');
  return toItem(rows[0]);
}

export async function deleteItem(userId, id) {
  const { rowCount } = await query('DELETE FROM items WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rowCount) throw notFound('Item not found');
}

/** Record a renewal: move the expiry date forward and keep an audit trail. */
export async function renewItem(userId, id, { newExpiryDate }, today) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT ${COLUMNS} FROM items WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('Item not found');
    const item = toItem(rows[0]);
    const target = newExpiryDate || suggestRenewalDate(item, today);
    const updated = await client.query(
      `UPDATE items SET expiry_date = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
      [id, userId, target],
    );
    await client.query(
      'INSERT INTO item_renewals (item_id, previous_expiry, new_expiry) VALUES ($1, $2, $3)',
      [id, item.expiryDate, target],
    );
    return toItem(updated.rows[0]);
  });
}

export async function listRenewals(userId, id) {
  await getItem(userId, id); // ownership check
  const { rows } = await query(
    `SELECT previous_expiry, new_expiry, renewed_at FROM item_renewals
     WHERE item_id = $1 ORDER BY renewed_at DESC LIMIT 50`,
    [id],
  );
  return rows.map((r) => ({ previousExpiry: r.previous_expiry, newExpiry: r.new_expiry, renewedAt: r.renewed_at }));
}

/**
 * Bulk import inside one transaction. Items identical to an existing one
 * (same title, category and expiry date) are skipped, so re-importing is safe.
 */
export async function importItems(userId, list) {
  return withTransaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]); // serialise per user
    const { rows } = await client.query('SELECT count(*)::int AS n FROM items WHERE user_id = $1', [userId]);
    if (rows[0].n + list.length > MAX_ITEMS_PER_USER) {
      throw new AppError(409, 'LIMIT_REACHED', `You can track up to ${MAX_ITEMS_PER_USER} items`);
    }
    const res = await client.query(
      `INSERT INTO items (user_id, title, category, ref, expiry_date, cycle_months, lead_days, note)
       SELECT $1, u.title, u.category, u.ref, u.expiry_date, u.cycle_months, u.lead_days, u.note
       FROM unnest($2::text[], $3::text[], $4::text[], $5::date[], $6::int[], $7::int[], $8::text[])
            AS u(title, category, ref, expiry_date, cycle_months, lead_days, note)
       WHERE NOT EXISTS (
         SELECT 1 FROM items i WHERE i.user_id = $1 AND i.title = u.title
           AND i.category = u.category AND i.expiry_date = u.expiry_date)`,
      [
        userId,
        list.map((i) => i.title), list.map((i) => i.category), list.map((i) => i.ref),
        list.map((i) => i.expiryDate), list.map((i) => i.cycleMonths), list.map((i) => i.leadDays),
        list.map((i) => i.note),
      ],
    );
    return { imported: res.rowCount, skipped: list.length - res.rowCount };
  });
}
