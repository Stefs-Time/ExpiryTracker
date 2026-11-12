/**
 * Centralised, validated configuration. The process fails fast at startup
 * when a required variable is missing or malformed.
 */
import { z } from 'zod';

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const schema = z.object({
  // On Railway, default to production so a forgotten NODE_ENV can't ship development
  // behaviour (non-Secure cookies, email bodies and reset links written to logs).
  NODE_ENV: z.enum(['development', 'test', 'production'])
    .default(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID ? 'production' : 'development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  APP_URL: z.string().url().optional(),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  MAIL_FROM: z.string().optional().default('VaultExpiry <no-reply@localhost>'),
  REMINDERS_ENABLED: bool(true),
  SIGNUP_ENABLED: bool(true),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  ADMIN_EMAIL: z.string().trim().toLowerCase().email('ADMIN_EMAIL must be an email address').optional().or(z.literal('')),
  ADMIN_PASSWORD: z.string().min(5, 'ADMIN_PASSWORD must be more than 4 characters').max(128).optional().or(z.literal('')),
  ADMIN_NAME: z.string().trim().min(1).max(80).optional().default('Platform Admin'),
  GROQ_API_KEY: z.string().trim().optional().default(''),
  GROQ_MODEL: z.string().trim().min(1).optional().default('qwen/qwen3.8-27b'),
  GROQ_BASE_URL: z.string().url().optional().default('https://api.groq.com/openai/v1'),
  GROQ_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  FILE_ENCRYPTION_KEY: z
    .string()
    .trim()
    .optional()
    .default('')
    .refine((v) => v === '' || Buffer.from(v, 'base64').length === 32, 'FILE_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

if (env.NODE_ENV === 'production' && !env.APP_URL) {
  console.error('Invalid configuration:\n  - APP_URL is required in production');
  process.exit(1);
}

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  appUrl: (env.APP_URL || `http://localhost:${env.PORT}`).replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY,
  db: {
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    poolMax: env.DATABASE_POOL_MAX,
  },
  sessionSecret: env.SESSION_SECRET,
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
  },
  remindersEnabled: env.REMINDERS_ENABLED,
  signupEnabled: env.SIGNUP_ENABLED,
  groq: {
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL,
    baseUrl: env.GROQ_BASE_URL.replace(/\/+$/, ''),
    timeoutMs: env.GROQ_TIMEOUT_MS,
  },
  scanEnabled: Boolean(env.GROQ_API_KEY),
  fileEncryptionKey: env.FILE_ENCRYPTION_KEY ? Buffer.from(env.FILE_ENCRYPTION_KEY, 'base64') : null,
  attachmentsEnabled: Boolean(env.FILE_ENCRYPTION_KEY),
  bootstrapAdmin: {
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
    name: env.ADMIN_NAME,
  },
});
