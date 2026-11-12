/**
 * Expiry domain logic shared by the server (Node ESM import) and the browser.
 * Pure functions only — no DOM, no I/O. All dates are ISO 'YYYY-MM-DD' strings
 * representing calendar days (no time / timezone component).
 */

export const CATEGORIES = Object.freeze({
  Vehicle: { label: 'Vehicle licence disc', icon: 'car', defaultCycle: 12, defaultLead: 30 },
  License: { label: "Driver's licence", icon: 'id-card', defaultCycle: 60, defaultLead: 60 },
  Firearm: { label: 'Firearm licence', icon: 'crosshair', defaultCycle: 60, defaultLead: 120 },
  Banking: { label: 'Bank card', icon: 'credit-card', defaultCycle: 48, defaultLead: 30 },
  Identity: { label: 'Passport / ID', icon: 'globe', defaultCycle: 120, defaultLead: 180 },
  Insurance: { label: 'Insurance policy', icon: 'umbrella', defaultCycle: 12, defaultLead: 30 },
  Medical: { label: 'Medical / certificate', icon: 'heart-pulse', defaultCycle: 12, defaultLead: 30 },
  Subscription: { label: 'Subscription', icon: 'repeat', defaultCycle: 12, defaultLead: 14 },
  Other: { label: 'Other document', icon: 'file-badge', defaultCycle: 12, defaultLead: 30 },
});

export const CATEGORY_KEYS = Object.freeze(Object.keys(CATEGORIES));
export const STATUSES = Object.freeze(['critical', 'soon', 'valid']);
export const DEFAULT_THRESHOLDS = Object.freeze({ criticalDays: 30, warningDays: 90 });

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Validate a real calendar date in ISO form (rejects 2026-02-30). */
export function isISODate(value) {
  const m = ISO_RE.exec(String(value));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today's calendar date in an IANA timezone, e.g. 'Africa/Johannesburg'. */
export function todayIn(timeZone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Whole days from `fromISO` to `toISO` (negative when `toISO` is earlier). */
export function daysBetween(fromISO, toISO) {
  return Math.round((toUTC(toISO) - toUTC(fromISO)) / MS_PER_DAY);
}

/** Add calendar months, clamping to month end (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const ty = y + Math.floor(targetMonthIndex / 12);
  const tm = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromUTC(Date.UTC(ty, tm, Math.min(d, lastDay)));
}

export function addDays(iso, days) {
  return fromUTC(toUTC(iso) + days * MS_PER_DAY);
}

/**
 * Suggested new expiry when renewing: one cycle after the current expiry,
 * or one cycle after today when the item has already lapsed.
 */
export function suggestRenewalDate(item, todayISO) {
  const base = item.expiryDate > todayISO ? item.expiryDate : todayISO;
  return addMonths(base, Number(item.cycleMonths) || 12);
}

export function formatCycle(months) {
  const m = Number(months);
  if (m % 12 === 0) return m === 12 ? '1Y' : `${m / 12}Y`;
  return `${m}M`;
}

/**
 * Classify an item relative to `todayISO`.
 * - critical: expired, or expiring within criticalDays
 * - soon:     expiring within warningDays
 * - valid:    beyond warningDays
 */
export function evaluate(item, todayISO, thresholds = DEFAULT_THRESHOLDS) {
  const { criticalDays, warningDays } = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const daysLeft = daysBetween(todayISO, item.expiryDate);
  const expired = daysLeft < 0;

  let status = 'valid';
  if (daysLeft <= criticalDays) status = 'critical';
  else if (daysLeft <= warningDays) status = 'soon';

  let label;
  if (expired) {
    const n = Math.abs(daysLeft);
    label = n === 1 ? 'Expired 1 day ago' : `Expired ${n.toLocaleString('en-GB')} days ago`;
  } else if (daysLeft === 0) {
    label = 'Expires today';
  } else {
    label = daysLeft === 1 ? '1 day left' : `${daysLeft.toLocaleString('en-GB')} days left`;
  }

  // Share of the validity cycle still remaining (0..100). Expired shows a full "overdue" bar.
  const cycleDays = Math.max(1, daysBetween(addMonths(item.expiryDate, -(Number(item.cycleMonths) || 12)), item.expiryDate));
  const remainingPct = expired ? 100 : Math.max(2, Math.min(100, Math.round((daysLeft / cycleDays) * 100)));

  const leadDays = Number(item.leadDays ?? 30);
  const renewalWindowOpen = !expired && daysLeft <= leadDays;

  return { daysLeft, expired, status, label, remainingPct, renewalWindowOpen };
}

/** Summary counts + items sorted most-urgent first. */
export function summarise(items, todayISO, thresholds) {
  const evaluated = items
    .map((item) => ({ ...item, ...evaluate(item, todayISO, thresholds) }))
    .sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title));
  const counts = { total: evaluated.length, critical: 0, soon: 0, valid: 0, expired: 0 };
  for (const i of evaluated) {
    counts[i.status] += 1;
    if (i.expired) counts.expired += 1;
  }
  return { items: evaluated, counts };
}

/** Human-readable date, e.g. '04 Dec 2026'. */
export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** Reminder stage an item is currently in, or null. Used by the email reminder job. */
export function reminderStage(item, todayISO, thresholds = DEFAULT_THRESHOLDS) {
  const { criticalDays, warningDays } = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const d = daysBetween(todayISO, item.expiryDate);
  if (d < 0) return d >= -30 ? 'expired' : null; // stop nagging a month after expiry
  if (d <= 7) return 'week';
  if (d <= criticalDays) return 'critical';
  if (d <= Number(item.leadDays ?? 0)) return 'lead';
  if (d <= warningDays) return 'warning';
  return null;
}
