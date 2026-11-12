/**
 * Creates (or refreshes) a demo account with sample items dated relative to today.
 * Development only — refuses to run when NODE_ENV=production.
 *
 *   npm run seed:demo        → demo@vaultexpiry.local / demo-password-123
 */
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/services/users.js';
import { addMonths, addDays, todayIn } from '../public/js/shared/expiry.js';

if (config.isProd) {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const EMAIL = 'demo@vaultexpiry.local';
const PASSWORD = 'demo-password-123';
const today = todayIn('Africa/Johannesburg');

const items = [
  ['Car licence disc (VW Tiguan)', 'Vehicle', 'GP ••• 492-ZN', addDays(today, -12), 12, 30, 'Renew via eNaTIS online or at the Post Office'],
  ["Driver's licence card (Code B)", 'License', 'DL •••• 8834', addDays(today, 22), 60, 60, 'Eye test & DLTC booking required'],
  ['Primary cheque bank card', 'Banking', '•••• 7419', addDays(today, 57), 48, 30, 'Auto-renews; update debit orders on arrival'],
  ['Firearm licence (Sec 13 self-defence)', 'Firearm', 'SAPS •••• 3109', addDays(today, 280), 60, 120, 'Submit renewal at least 90 days before expiry'],
  ['SA tourist passport', 'Identity', 'M00 •••• 612', addMonths(today, 53), 120, 180, 'DHA branch or bank branch'],
  ['Firearm competency certificate', 'Firearm', 'COMP •••• 904', addDays(today, 914), 60, 120, 'Handgun & rifle proficiency'],
];

await migrate();
const hash = await hashPassword(PASSWORD);
const { rows } = await pool.query(
  `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, 'Demo User')
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_logins = 0, locked_until = NULL
   RETURNING id`,
  [EMAIL, hash],
);
const userId = rows[0].id;
await pool.query('DELETE FROM items WHERE user_id = $1', [userId]);
for (const [title, category, ref, expiry, cycle, lead, note] of items) {
  await pool.query(
    `INSERT INTO items (user_id, title, category, ref, expiry_date, cycle_months, lead_days, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, title, category, ref, expiry, cycle, lead, note],
  );
}
await pool.end();
console.log(`Demo account ready: ${EMAIL} / ${PASSWORD} (${items.length} items)`);
