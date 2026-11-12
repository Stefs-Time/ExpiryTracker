/**
 * Encrypted document photos ("digital copies") attached to items.
 * Stored in PostgreSQL as AES-256-GCM ciphertext (see lib/crypto-box.js), because
 * Railway containers have no persistent disk. Listing never reads the `data` column.
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { AppError, notFound } from '../lib/errors.js';
import { encrypt, decrypt } from '../lib/crypto-box.js';
import { sanitizeJpeg, InvalidImageError } from '../lib/jpeg.js';

export const LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024, // per photo, after sanitising
  perItem: 4, // e.g. front, back + 2 others
  perUserBytes: 100 * 1024 * 1024,
});

const META = 'id, item_id, label, content_type, byte_size, width, height, created_at';

const toMeta = (r) => ({
  id: r.id,
  itemId: r.item_id,
  label: r.label,
  contentType: r.content_type,
  byteSize: r.byte_size,
  width: r.width,
  height: r.height,
  createdAt: r.created_at,
  url: `/api/items/${r.item_id}/attachments/${r.id}`,
});

/** Validate + strip metadata. Throws a 415/422 AppError for bad input. */
export function prepareImage(body) {
  if (!Buffer.isBuffer(body) || !body.length) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a JPEG photo');
  }
  try {
    return sanitizeJpeg(body);
  } catch (err) {
    if (err instanceof InvalidImageError) throw new AppError(422, 'INVALID_IMAGE', `That file isn't a valid photo (${err.message.toLowerCase()})`);
    throw err;
  }
}

async function assertOwnsItem(client, userId, itemId) {
  const { rows } = await client.query('SELECT id FROM items WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [itemId, userId]);
  if (!rows[0]) throw notFound('Item not found');
}

export async function listAttachments(userId, itemId) {
  const { rows: own } = await query('SELECT 1 FROM items WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [itemId, userId]);
  if (!own[0]) throw notFound('Item not found');
  const { rows } = await query(
    `SELECT ${META} FROM item_attachments WHERE item_id = $1 AND user_id = $2 ORDER BY created_at`,
    [itemId, userId],
  );
  return rows.map(toMeta);
}

export async function addAttachment(userId, itemId, { label = 'front', body }) {
  const img = prepareImage(body);
  if (img.buffer.length > LIMITS.maxBytes) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'That photo is too large (max 4 MB)');
  }
  return withTransaction(async (client) => {
    await assertOwnsItem(client, userId, itemId); // row lock serialises concurrent uploads per item
    const { rows: counts } = await client.query(
      `SELECT (SELECT count(*)::int FROM item_attachments WHERE item_id = $1) AS per_item,
              (SELECT coalesce(sum(byte_size), 0)::bigint FROM item_attachments WHERE user_id = $2) AS user_bytes`,
      [itemId, userId],
    );
    if (counts[0].per_item >= LIMITS.perItem) {
      throw new AppError(409, 'LIMIT_REACHED', `Each item can have up to ${LIMITS.perItem} photos. Delete one first.`);
    }
    if (Number(counts[0].user_bytes) + img.buffer.length > LIMITS.perUserBytes) {
      throw new AppError(409, 'LIMIT_REACHED', 'You have reached your photo storage limit (100 MB). Delete some photos first.');
    }
    const id = crypto.randomUUID();
    const box = encrypt(img.buffer, id);
    const { rows } = await client.query(
      `INSERT INTO item_attachments
         (id, item_id, user_id, label, content_type, byte_size, width, height, sha256, key_version, iv, auth_tag, data)
       VALUES ($1, $2, $3, $4, 'image/jpeg', $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${META}`,
      [id, itemId, userId, label, img.buffer.length, img.width, img.height,
        crypto.createHash('sha256').update(img.buffer).digest('hex'), box.keyVersion, box.iv, box.authTag, box.data],
    );
    return toMeta(rows[0]);
  });
}

/** Decrypt and return the photo bytes. Ownership is enforced in SQL. */
export async function readAttachment(userId, itemId, attachmentId) {
  const { rows } = await query(
    `SELECT a.id, a.content_type, a.sha256, a.iv, a.auth_tag, a.data FROM item_attachments a
     JOIN items i ON i.id = a.item_id AND i.deleted_at IS NULL
     WHERE a.id = $1 AND a.item_id = $2 AND a.user_id = $3`,
    [attachmentId, itemId, userId],
  );
  const r = rows[0];
  if (!r) throw notFound('Photo not found');
  const plain = decrypt({ iv: r.iv, authTag: r.auth_tag, data: r.data }, r.id);
  return { contentType: r.content_type, body: plain, etag: `"${r.sha256.slice(0, 32)}"` };
}

export async function deleteAttachment(userId, itemId, attachmentId) {
  const { rowCount } = await query(
    `DELETE FROM item_attachments a USING items i
     WHERE a.id = $1 AND a.item_id = $2 AND a.user_id = $3 AND i.id = a.item_id AND i.deleted_at IS NULL`,
    [attachmentId, itemId, userId],
  );
  if (!rowCount) throw notFound('Photo not found');
}

/** Metadata (no bytes) of every photo on the user's live items — for data export. */
export async function listUserPhotos(userId) {
  const { rows } = await query(
    `SELECT a.${META.split(', ').join(', a.')} FROM item_attachments a
     JOIN items i ON i.id = a.item_id AND i.deleted_at IS NULL
     WHERE a.user_id = $1 ORDER BY a.created_at`,
    [userId],
  );
  return rows.map(toMeta);
}

export async function storageUsage(userId) {
  const { rows } = await query(
    'SELECT count(*)::int AS photos, coalesce(sum(byte_size), 0)::bigint AS bytes FROM item_attachments WHERE user_id = $1',
    [userId],
  );
  return { photos: rows[0].photos, bytes: Number(rows[0].bytes), limitBytes: LIMITS.perUserBytes };
}
