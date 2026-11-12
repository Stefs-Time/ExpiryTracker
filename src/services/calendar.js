/**
 * RFC 5545 iCalendar generation. Each item becomes an all-day event on its
 * expiry date with alarms at the item's lead time, 7 days before, and on the day.
 */
import { CATEGORIES, addDays } from '../../public/js/shared/expiry.js';

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold content lines longer than 75 octets (RFC 5545 §3.1). */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = '';
  for (const ch of line) {
    if (Buffer.byteLength(current + ch, 'utf8') > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const compactDate = (iso) => iso.replaceAll('-', '');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function alarm(triggerDays, description) {
  // Relative to the all-day event start (00:00 local): fire at 09:00 on the target day.
  // n days before at 09:00 == -(n-1 days + 15 hours).
  const trigger = triggerDays === 0 ? 'PT9H' : `-P${triggerDays - 1}DT15H`;
  return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(description)}`, `TRIGGER:${trigger}`, 'END:VALARM'];
}

export function buildCalendar(items, { appUrl, calendarName = 'VaultExpiry' }) {
  const now = stamp();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VaultExpiry//Expiry Tracker//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];

  for (const item of items) {
    const label = CATEGORIES[item.category]?.label || 'Document';
    const descParts = [`${label} expires.`];
    if (item.ref) descParts.push(`Ref: ${item.ref}`);
    if (item.note) descParts.push(item.note);
    descParts.push(`Manage: ${appUrl}/`);
    const alarms = new Set([Number(item.leadDays) || 0, 7, 0]);

    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.id}@vaultexpiry`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${compactDate(item.expiryDate)}`,
      `DTEND;VALUE=DATE:${compactDate(addDays(item.expiryDate, 1))}`,
      `SUMMARY:${escapeText(`Expires: ${item.title}`)}`,
      `DESCRIPTION:${escapeText(descParts.join('\n'))}`,
      `CATEGORIES:${escapeText(label)}`,
      'TRANSP:TRANSPARENT',
    );
    for (const days of [...alarms].sort((a, b) => b - a)) {
      const text = days === 0 ? `${item.title} expires today` : `${item.title} expires in ${days} days`;
      lines.push(...alarm(days, text));
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
