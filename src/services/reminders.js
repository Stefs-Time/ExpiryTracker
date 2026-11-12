/**
 * Email reminder job.
 *
 * Runs hourly in-process. A PostgreSQL advisory lock ensures only one replica
 * runs a pass at a time. For each user with reminders enabled, items that have
 * entered a new reminder stage (lead time, warning, critical, final week,
 * expired) are collected into one digest email. reminder_log stores
 * (item, expiry_date, stage) so each stage is sent at most once per expiry date;
 * renewing an item (new expiry date) re-arms all stages.
 */
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { sendMail, escapeHtml, mailEnabled } from './mailer.js';
import { todayIn, reminderStage, evaluate, formatDate } from '../../public/js/shared/expiry.js';

const LOCK_KEY = 74_210_002;
const INTERVAL_MS = 60 * 60 * 1000;
const SEND_AFTER_LOCAL_HOUR = 7; // don't email before 07:00 in the user's timezone

function localHour(timeZone, now) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  } catch {
    return now.getUTCHours();
  }
}

function digest(user, entries) {
  const lines = entries.map((e) => `• ${e.title}${e.ref ? ` (${e.ref})` : ''} — ${e.label}, ${formatDate(e.expiryDate)}`);
  const text = [
    `Hi ${user.display_name},`,
    '',
    'These items need your attention:',
    '',
    ...lines,
    '',
    `Open VaultExpiry: ${config.appUrl}/`,
    '',
    'You can turn reminder emails off under Settings.',
  ].join('\n');
  const rows = entries
    .map(
      (e) => `<tr><td style="padding:6px 12px 6px 0"><strong>${escapeHtml(e.title)}</strong><br><span style="color:#64748b;font-family:monospace">${escapeHtml(e.ref)}</span></td>
      <td style="padding:6px 0;font-family:monospace">${escapeHtml(formatDate(e.expiryDate))}<br><span style="color:${e.status === 'critical' ? '#e11d48' : '#d97706'}">${escapeHtml(e.label)}</span></td></tr>`,
    )
    .join('');
  const html = `<div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px">
    <p>Hi ${escapeHtml(user.display_name)},</p><p>These items need your attention:</p>
    <table style="border-collapse:collapse;font-size:14px">${rows}</table>
    <p><a href="${escapeHtml(config.appUrl)}/" style="color:#059669">Open VaultExpiry</a></p>
    <p style="color:#64748b;font-size:12px">You can turn reminder emails off under Settings.</p></div>`;
  const urgent = entries.filter((e) => e.status === 'critical').length;
  const subject = urgent
    ? `VaultExpiry: ${urgent} item${urgent === 1 ? '' : 's'} need${urgent === 1 ? 's' : ''} renewing`
    : `VaultExpiry: ${entries.length} upcoming renewal${entries.length === 1 ? '' : 's'}`;
  return { subject, text, html };
}

/** One pass over all users. Exported for tests and manual runs. */
export async function runReminderPass(now = new Date()) {
  const client = await pool.connect();
  let sent = 0;
  try {
    const { rows: lock } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!lock[0].ok) return { skipped: true, sent };
    try {
      const { rows: users } = await client.query(
        `SELECT id, email, display_name, timezone, critical_days, warning_days
         FROM users WHERE email_reminders = TRUE AND disabled_at IS NULL`,
      );
      for (const user of users) {
        if (localHour(user.timezone, now) < SEND_AFTER_LOCAL_HOUR) continue;
        const today = todayIn(user.timezone, now);
        const thresholds = { criticalDays: user.critical_days, warningDays: user.warning_days };
        const horizon = Math.max(user.warning_days, 365);
        const { rows: items } = await client.query(
          `SELECT i.id, i.title, i.ref, i.expiry_date AS "expiryDate", i.cycle_months AS "cycleMonths",
                  i.lead_days AS "leadDays"
           FROM items i
           WHERE i.user_id = $1 AND i.deleted_at IS NULL
             AND i.expiry_date BETWEEN $2::date - 30 AND $2::date + $3::int
           ORDER BY i.expiry_date`,
          [user.id, today, horizon],
        );
        const due = [];
        for (const item of items) {
          const stage = reminderStage(item, today, thresholds);
          if (stage) due.push({ ...item, stage, ...evaluate(item, today, thresholds) });
        }
        if (!due.length) continue;

        // Claim stages not yet sent (ON CONFLICT skips already-sent ones).
        const { rows: claimed } = await client.query(
          `INSERT INTO reminder_log (item_id, expiry_date, stage)
           SELECT * FROM unnest($1::uuid[], $2::date[], $3::text[])
           ON CONFLICT DO NOTHING RETURNING item_id, expiry_date, stage`,
          [due.map((d) => d.id), due.map((d) => d.expiryDate), due.map((d) => d.stage)],
        );
        if (!claimed.length) continue;
        const claimedIds = new Set(claimed.map((c) => c.item_id));
        const entries = due.filter((d) => claimedIds.has(d.id));
        try {
          const delivered = await sendMail({ to: user.email, ...digest(user, entries) });
          if (!delivered) throw new Error('Mail transport unavailable');
          sent += 1;
        } catch (err) {
          // Release the claims so the next pass retries.
          await client.query(
            `DELETE FROM reminder_log r USING unnest($1::uuid[], $2::date[], $3::text[]) AS u(item_id, expiry_date, stage)
             WHERE r.item_id = u.item_id AND r.expiry_date = u.expiry_date AND r.stage = u.stage`,
            [claimed.map((c) => c.item_id), claimed.map((c) => c.expiry_date), claimed.map((c) => c.stage)],
          );
          logger.warn('Reminder email failed', { userId: user.id, err: err.message });
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return { skipped: false, sent };
}

let timer;
export function startReminderScheduler() {
  if (!config.remindersEnabled) return;
  if (!mailEnabled() && config.isProd) {
    logger.warn('Reminder scheduler not started: SMTP is not configured');
    return;
  }
  const tick = () =>
    runReminderPass()
      .then((r) => r.sent && logger.info('Reminder pass complete', r))
      .catch((err) => logger.error('Reminder pass failed', { err: err.message }));
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  setTimeout(tick, 30_000).unref(); // first pass shortly after boot
}

export function stopReminderScheduler() {
  clearInterval(timer);
}
