/**
 * Human-friendly validation messages for every zod schema (global config).
 * Explicit messages on individual schemas still take precedence.
 * Without this, users would see zod defaults such as
 * "Too big: expected number to be <=365".
 */
import { z } from 'zod';

const LABELS = {
  email: 'Email',
  password: 'Password',
  newPassword: 'New password',
  currentPassword: 'Current password',
  displayName: 'Name',
  timezone: 'Timezone',
  title: 'Title',
  category: 'Category',
  ref: 'Reference',
  expiryDate: 'Expiry date',
  newExpiryDate: 'New expiry date',
  cycleMonths: 'Validity cycle',
  leadDays: 'Renewal lead time',
  note: 'Note',
  criticalDays: 'Critical window',
  warningDays: '"Expiring soon" window',
  emailReminders: 'Email reminders',
  confirmEmail: 'Confirmation email',
  items: 'Import file',
  q: 'Search',
  body: 'Note',
  reason: 'Reason',
  action: 'Action',
  status: 'Status',
  role: 'Role',
  sort: 'Sort order',
  page: 'Page',
  limit: 'Page size',
};

const UNITS = { leadDays: 'days', criticalDays: 'days', warningDays: 'days', cycleMonths: 'months' };

function fieldOf(path = []) {
  const key = [...path].reverse().find((p) => typeof p === 'string');
  return key;
}

z.config({
  customError(iss) {
    const key = fieldOf(iss.path);
    const label = LABELS[key] || 'This field';
    const unit = (n) => (UNITS[key] ? ` ${Number(n) === 1 ? UNITS[key].replace(/s$/, '') : UNITS[key]}` : '');

    if (key === 'token') return 'This reset link is incomplete or damaged. Request a new one.';

    switch (iss.code) {
      case 'invalid_type':
        if (iss.input === undefined || iss.input === null || iss.input === '') return `${label} is required`;
        return iss.expected === 'number' ? `${label} must be a number` : `${label} is not valid`;
      case 'too_small':
        if (iss.origin === 'string') {
          return Number(iss.minimum) <= 1 ? `${label} is required` : `${label} must be at least ${iss.minimum} characters`;
        }
        if (iss.origin === 'array') return `${label} has nothing to import`;
        return `${label} must be at least ${iss.minimum}${unit(iss.minimum)}`;
      case 'too_big':
        if (iss.origin === 'string') return `${label} must be ${iss.maximum} characters or fewer`;
        if (iss.origin === 'array') return `${label} can contain at most ${iss.maximum} entries`;
        return `${label} must be ${iss.maximum}${unit(iss.maximum)} or less`;
      case 'invalid_value':
        return `Choose a valid ${label.toLowerCase()}`;
      case 'invalid_format':
        return key === 'email' || key === 'confirmEmail' ? 'Enter a valid email address' : `${label} is not in a valid format`;
      case 'unrecognized_keys':
        return `Unexpected field${iss.keys?.length === 1 ? '' : 's'}: ${(iss.keys || []).join(', ')}`;
      default:
        return undefined; // fall back to zod's message (or the schema's own)
    }
  },
});
