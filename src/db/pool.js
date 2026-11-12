import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates. A DATE has
// no timezone; converting it to a Date shifts it by the server's UTC offset.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  application_name: 'vaultexpiry',
});

pool.on('error', (err) => logger.error('Idle PostgreSQL client error', { err: err.message }));

export const query = (text, params) => pool.query(text, params);

/** Run `fn(client)` inside a transaction; rolls back on any thrown error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
