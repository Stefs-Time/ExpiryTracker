import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, daysBetween, evaluate, isISODate, reminderStage, suggestRenewalDate, summarise, todayIn,
} from '../public/js/shared/expiry.js';

test('isISODate rejects impossible dates', () => {
  assert.equal(isISODate('2026-02-28'), true);
  assert.equal(isISODate('2028-02-29'), true);
  assert.equal(isISODate('2026-02-29'), false);
  assert.equal(isISODate('2026-13-01'), false);
  assert.equal(isISODate('26-1-1'), false);
});

test('addMonths clamps to month end and handles negatives', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-02-29', 12), '2029-02-28');
  assert.equal(addMonths('2026-11-12', 60), '2031-11-12');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
});

test('daysBetween is timezone-independent', () => {
  assert.equal(daysBetween('2026-11-12', '2026-12-04'), 22);
  assert.equal(daysBetween('2026-11-12', '2026-10-31'), -12);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2); // across EU DST change
});

test('evaluate classifies by thresholds', () => {
  const today = '2026-11-12';
  const it = (expiryDate) => ({ expiryDate, cycleMonths: 12, leadDays: 30 });
  assert.equal(evaluate(it('2026-10-31'), today).status, 'critical');
  assert.equal(evaluate(it('2026-10-31'), today).expired, true);
  assert.equal(evaluate(it('2026-10-31'), today).label, 'Expired 12 days ago');
  assert.equal(evaluate(it('2026-11-12'), today).label, 'Expires today');
  assert.equal(evaluate(it('2026-12-12'), today).status, 'critical'); // 30 days
  assert.equal(evaluate(it('2026-12-13'), today).status, 'soon'); // 31 days
  assert.equal(evaluate(it('2027-02-10'), today).status, 'soon'); // 90 days
  assert.equal(evaluate(it('2027-02-11'), today).status, 'valid'); // 91 days
  assert.equal(evaluate(it('2027-02-11'), today, { criticalDays: 7, warningDays: 120 }).status, 'soon');
});

test('suggestRenewalDate uses current expiry if future, else today', () => {
  assert.equal(suggestRenewalDate({ expiryDate: '2027-01-08', cycleMonths: 48 }, '2026-11-12'), '2031-01-08');
  assert.equal(suggestRenewalDate({ expiryDate: '2026-10-31', cycleMonths: 12 }, '2026-11-12'), '2027-11-12');
});

test('summarise sorts most urgent first and counts', () => {
  const items = [
    { title: 'B', expiryDate: '2030-01-01', cycleMonths: 12 },
    { title: 'A', expiryDate: '2026-10-01', cycleMonths: 12 },
    { title: 'C', expiryDate: '2027-01-01', cycleMonths: 12 },
  ];
  const { items: out, counts } = summarise(items, '2026-11-12');
  assert.deepEqual(out.map((i) => i.title), ['A', 'C', 'B']);
  assert.deepEqual(counts, { total: 3, critical: 1, soon: 1, valid: 1, expired: 1 });
});

test('reminderStage progresses through windows', () => {
  const t = '2026-11-12';
  const it = (expiryDate, leadDays = 120) => ({ expiryDate, leadDays });
  assert.equal(reminderStage(it('2027-06-01'), t), null);
  assert.equal(reminderStage(it('2027-02-01'), t), 'lead'); // 81 days, lead 120 > warning 90
  assert.equal(reminderStage(it('2027-02-01', 30), t), 'warning');
  assert.equal(reminderStage(it('2026-12-01'), t), 'critical');
  assert.equal(reminderStage(it('2026-11-15'), t), 'week');
  assert.equal(reminderStage(it('2026-11-01'), t), 'expired');
  assert.equal(reminderStage(it('2026-09-01'), t), null);
});

test('todayIn respects timezone', () => {
  const instant = new Date('2026-11-12T23:30:00Z');
  assert.equal(todayIn('UTC', instant), '2026-11-12');
  assert.equal(todayIn('Africa/Johannesburg', instant), '2026-11-13');
  assert.equal(todayIn('America/Los_Angeles', instant), '2026-11-12');
});
