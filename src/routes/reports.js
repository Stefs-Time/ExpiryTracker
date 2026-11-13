/** Status report (JSON / CSV / plain text) and the signed-in .ics download. */
import { Router } from 'express';
import { config } from '../config.js';
import * as items from '../services/items.js';
import { buildCalendar } from '../services/calendar.js';
import { toCsv } from '../lib/csv.js';
import { summarise, todayIn, plainTextReport, CATEGORIES } from '../../public/js/shared/expiry.js';

const router = Router();

async function report(user) {
  const today = todayIn(user.timezone);
  const summary = summarise(await items.allItems(user.id), today, {
    criticalDays: user.critical_days,
    warningDays: user.warning_days,
  });
  return { today, ...summary };
}

router.get('/status', async (req, res) => {
  const { today, counts, items: rows } = await report(req.user);
  res.json({ success: true, data: { today, counts, items: rows } });
});

router.get('/status.csv', async (req, res) => {
  const { today, items: rows } = await report(req.user);
  const header = ['Title', 'Category', 'Reference', 'Expiry date', 'Days left', 'Status', 'Cycle (months)', 'Renewal lead (days)', 'Note'];
  const cells = rows.map((i) => [
    i.title, CATEGORIES[i.category]?.label || i.category, i.ref, i.expiryDate, i.daysLeft,
    i.expired ? 'expired' : i.status, i.cycleMonths, i.leadDays, i.note,
  ]);
  res.type('text/csv; charset=utf-8').attachment(`vaultexpiry-status-${today}.csv`).send(toCsv(header, cells));
});

router.get('/status.txt', async (req, res) => {
  const { today, ...summary } = await report(req.user);
  res.type('text/plain; charset=utf-8').send(plainTextReport(summary, today) + '\n');
});

router.get('/calendar.ics', async (req, res) => {
  const ics = buildCalendar(await items.allItems(req.user.id), { appUrl: config.appUrl });
  res.type('text/calendar; charset=utf-8').attachment('vaultexpiry.ics').send(ics);
});

export default router;
