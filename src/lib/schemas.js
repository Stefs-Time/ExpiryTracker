import { z } from 'zod';
import { CATEGORY_KEYS, STATUSES, isISODate, isValidTimeZone } from '../../public/js/shared/expiry.js';

const trimmed = (max) => z.string().trim().max(max);

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }));

// NIST SP 800-63B: length over composition rules; cap length to bound hashing cost.
export const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters');

const timezone = z.string().max(64).refine(isValidTimeZone, 'Unknown timezone');

export const signupSchema = z.object({
  email,
  password,
  displayName: trimmed(80).min(1, 'Name is required'),
  timezone: timezone.optional().default('Africa/Johannesburg'),
});

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const forgotSchema = z.object({ email });
export const resetSchema = z.object({ token: z.string().min(20).max(200), password });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
});

export const deleteAccountSchema = z.object({ password: z.string().min(1).max(128) });

export const settingsSchema = z
  .object({
    displayName: trimmed(80).min(1),
    timezone,
    criticalDays: z.number().int().min(1).max(365),
    warningDays: z.number().int().min(2).max(730),
    emailReminders: z.boolean(),
  })
  .partial()
  .strict();

const isoDate = z.string().refine(isISODate, 'Use a valid date (YYYY-MM-DD)');

// Guard against storing full card / ID numbers: refs are meant to be masked.
const ref = trimmed(40).refine(
  (v) => !/\d{10,}/.test(v.replace(/[\s-]/g, '')),
  'Store a masked reference only (e.g. last 4 digits) — never a full card or ID number',
);

const itemFields = {
  title: trimmed(120).min(1, 'Title is required'),
  category: z.enum(CATEGORY_KEYS),
  ref: ref.default(''),
  expiryDate: isoDate.refine((v) => v >= '1900-01-01' && v <= '2200-12-31', 'Date out of range'),
  cycleMonths: z.number().int().min(1).max(240).default(12),
  leadDays: z.number().int().min(0).max(365).default(30),
  note: trimmed(500).default(''),
};

export const createItemSchema = z.object(itemFields).strict();

export const updateItemSchema = z
  .object({
    title: itemFields.title,
    category: itemFields.category,
    ref,
    expiryDate: itemFields.expiryDate,
    cycleMonths: z.number().int().min(1).max(240),
    leadDays: z.number().int().min(0).max(365),
    note: trimmed(500),
  })
  .partial()
  .strict();

// Import accepts our own export format; unknown fields (id, createdAt…) are ignored.
export const importSchema = z.object({
  items: z.array(z.object(itemFields)).min(1, 'No items to import').max(500, 'Import at most 500 items at a time'),
});

export const renewSchema = z.object({ newExpiryDate: isoDate.optional() }).strict();

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.enum(CATEGORY_KEYS).optional(),
  status: z.enum(STATUSES).optional(),
  sort: z.enum(['expiry', '-expiry', 'title', 'created']).optional().default('expiry'),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

export const uuid = z.uuid({ message: 'Invalid id' });
