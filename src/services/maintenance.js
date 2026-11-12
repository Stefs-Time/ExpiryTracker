/**
 * Periodic housekeeping (every 10 minutes, idempotent, safe on multiple replicas):
 * - permanently delete items soft-deleted longer than the undo window
 *   (their photos and renewal history cascade), so deleted documents don't linger;
 * - delete expired or used password-reset tokens.
 */
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { purgeDeletedItems } from './items.js';

const INTERVAL_MS = 10 * 60 * 1000;
let timer;

export async function runMaintenance() {
  const items = await purgeDeletedItems();
  const { rowCount: resets } = await query(
    `DELETE FROM password_resets WHERE expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day'`,
  );
  if (items || resets) logger.info('Maintenance', { purgedItems: items, purgedResetTokens: resets });
  return { items, resets };
}

export function startMaintenance() {
  const tick = () => runMaintenance().catch((err) => logger.error('Maintenance failed', { err: err.message }));
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  setTimeout(tick, 5_000).unref();
}

export function stopMaintenance() {
  clearInterval(timer);
}
