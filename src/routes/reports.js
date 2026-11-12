import { Router } from 'express';
import { config } from '../config.js';
import * as items from '../services/items.js';
import { buildCalendar } from '../services/calendar.js';
import { summarise, todayIn, formatDate, CATEGORIES } from '../../public/js/shared/expiry.js';

const router = Router();

async function report(user) {
  const today = todayIn(user.timezone);
  const all = await items.allItems(user.id);
  const { items: evaluated, counts } = summarise(all, today, {
    criticalDays: user.critical_days,
    warningDays: user.warning_days,
  });
  return { today, counts, items: evaluated };
}

router.get('/status', async (req, res, next) => {
  try {
    res.json({ success: true, data: await report(req.user) });
  } catch (err) {
    next(err);
  }
});

function csvCell(value) {
  let s = String(value ?? '');
  // Neutralise spreadsheet formula injection (OWASP CSV injection).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/status.csv', async (req, res, next) => {
  try {
    const { today, items: rows } = await report(req.user);
    const header = ['Title', 'Category', 'Reference', 'Expiry date', 'Days left', 'Status', 'Cycle (months)', 'Renewal lead (days)', 'Note'];
    const lines = [header, ...rows.map((i) => [
      i.title, CATEGORIES[i.category]?.label || i.category, i.ref, i.expiryDate, i.daysLeft,
      i.expired ? 'expired' : i.status, i.cycleMonths, i.leadDays, i.note,
    ])].map((r) => r.map(csvCell).join(','));
    res
      .type('text/csv; charset=utf-8')
      .attachment(`vaultexpiry-status-${today}.csv`)
      .send('﻿' + lines.join('\r\n') + '\r\n');
  } catch (err) {
    next(err);
  }
});

router.get('/status.txt', async (req, res, next) => {
  try {
    const { today, counts, items: rows } = await report(req.user);
    const flag = (i) => (i.expired ? '[EXPIRED] ' : i.status === 'critical' ? '[CRITICAL]' : i.status === 'soon' ? '[SOON]    ' : '[VALID]   ');
    const text = [
      'VAULTEXPIRY STATUS REPORT',
      `Report date: ${formatDate(today)} | Total tracked: ${counts.total}`,
      `Summary: ${counts.critical} critical (${counts.expired} expired) | ${counts.soon} expiring soon | ${counts.valid} valid`,
      '-'.repeat(60),
      ...rows.map((i) => `${flag(i)} ${i.title}${i.ref ? ` (${i.ref})` : ''} -> ${formatDate(i.expiryDate)} (${i.label})`),
    ].join('\n');
    res.type('text/plain; charset=utf-8').send(text + '\n');
  } catch (err) {
    next(err);
  }
});

router.get('/calendar.ics', async (req, res, next) => {
  try {
    const ics = buildCalendar(await items.allItems(req.user.id), { appUrl: config.appUrl });
    res.type('text/calendar; charset=utf-8').attachment('vaultexpiry.ics').send(ics);
  } catch (err) {
    next(err);
  }
});

export default router;
