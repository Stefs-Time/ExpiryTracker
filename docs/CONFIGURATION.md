# Configuration

All configuration comes from environment variables. They're validated at startup (`src/config.js`), and the app refuses to boot, with a clear log message, if a required variable is missing or malformed. Locally, put them in `.env` (copy `.env.example`). On Railway, set them on the **app service → Variables** tab.

In the **Source** column, "Railway" means Railway provides the value, either automatically or through a reference variable; "You" means you set it. Booleans accept `true`/`false` (or `1`/`0`). Empty values count as unset.

## Required

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | Railway (reference) | – | `${{Postgres.DATABASE_URL}}` | Paste the reference exactly as shown; Railway resolves it to the private-network URL of your Postgres service. Locally: `postgres://vault:vault@localhost:5432/vaultexpiry` |
| `SESSION_SECRET` | You | – | `kq3V…` (64 chars) | ≥ 32 random characters. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Changing it signs everyone out |
| `NODE_ENV` | You | `development` locally; **`production` automatically on Railway** | `production` | `production` turns on `Secure` cookies and HSTS, keeps email content out of logs, and makes `APP_URL` mandatory |
| `APP_URL` | You | `http://localhost:$PORT` (development only) | `https://vaultexpiry.up.railway.app` | Public URL, **no trailing slash**. Used in emails, calendar-feed links and the CSRF origin check. Required in production. You can write `https://${{RAILWAY_PUBLIC_DOMAIN}}` |

## Server & database (optional)

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `PORT` | Railway (automatic) | `3000` | – | Don't set it on Railway; the app listens on whatever is assigned, bound to `0.0.0.0` |
| `TRUST_PROXY` | You | `1` | `1` | Proxy hops in front of the app (Railway's edge is one). Affects client IPs in rate limits, access logs and the admin audit log |
| `DATABASE_SSL` | You | `false` | `true` | Only for a TLS-required **public** database URL. Encrypts without verifying the certificate; not needed with the private `${{Postgres.DATABASE_URL}}` |
| `DATABASE_POOL_MAX` | You | `10` | `5` | Connections per instance. Keep `replicas × DATABASE_POOL_MAX` below Postgres `max_connections` (100 by default) |

## Email (optional, needed for reminders and emailed password resets)

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `SMTP_HOST` | You | *(empty: email off)* | `smtp.resend.com` | Any SMTP provider (Resend, Postmark, Amazon SES, Brevo, Mailgun, Google Workspace…) |
| `SMTP_PORT` | You | `587` | `465` | |
| `SMTP_SECURE` | You | `false` | `true` | `true` for implicit TLS (usually port 465); `false` for STARTTLS (587) |
| `SMTP_USER` | You | *(empty)* | `resend` | |
| `SMTP_PASS` | You | *(empty)* | `re_xxxxxxxx` | Store it as a Railway variable, never in git |
| `MAIL_FROM` | You | `VaultExpiry <no-reply@localhost>` | `VaultExpiry <no-reply@yourdomain.co.za>` | Must be a sender your provider has verified |

Without SMTP the app still works: reminder emails aren't sent, "Forgot password" sends nothing (development logs the link instead), and the admin console gives the admin a one-time reset link to pass on.

## Features (optional)

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `REMINDERS_ENABLED` | You | `true` | `false` | Turns off the hourly reminder job on this instance. In production it also stays off when SMTP isn't configured |
| `SIGNUP_ENABLED` | You | `true` | `false` | `false` closes public registration; existing users can still sign in |

## Document photos & AI scanning (optional)

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `FILE_ENCRYPTION_KEY` | You | *(empty: photo storage off)* | `q3Jx…=` (44 chars) | 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Encrypts every stored photo (AES-256-GCM). **If this key is lost or changed, all stored photos become unreadable.** Keep a copy in a password manager, separate from database backups |
| `GROQ_API_KEY` | You | *(empty: scanning off)* | `gsk_…` | From [console.groq.com/keys](https://console.groq.com/keys). Enables "Scan or add a photo" |
| `GROQ_MODEL` | You | `qwen/qwen3.8-27b` | `qwen/qwen3.8-27b` | Must be a Groq **vision** model. Groq marks them as preview and can retire them at short notice, so check [console.groq.com/docs/vision](https://console.groq.com/docs/vision) |
| `GROQ_BASE_URL` | You | `https://api.groq.com/openai/v1` | – | Only change for testing (the test suites point it at a mock) |
| `GROQ_TIMEOUT_MS` | You | `30000` | `20000` | How long to wait for a reading before giving up |

The two features are independent. With only `FILE_ENCRYPTION_KEY`, users can attach photos but there's no AI reading. With only `GROQ_API_KEY`, photos are read and then discarded. See [PHOTOS.md](PHOTOS.md).

## Platform admin bootstrap (optional)

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `ADMIN_EMAIL` | You | *(empty: no bootstrap)* | `you@yourdomain.co.za` | On boot, creates this admin account **only if no account with this email exists** |
| `ADMIN_PASSWORD` | You | *(empty)* | a 20+ character passphrase (minimum 5 characters) | 5–128 characters. Short passwords are accepted with a logged warning; change the password in Settings (which requires 10+) after first sign-in. **Delete this variable after the first deploy**; the logs warn while it's still set |
| `ADMIN_NAME` | You | `Platform Admin` | `Stef` | Display name for the new admin |

See [ADMIN.md](ADMIN.md) for why the bootstrap never promotes an existing account.

## Copy-paste starter (Railway → Variables → Raw Editor)

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=<paste output of the generator command>
NODE_ENV=production
APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASS=<your provider API key>
MAIL_FROM=VaultExpiry <no-reply@yourdomain.co.za>
ADMIN_EMAIL=you@yourdomain.co.za
ADMIN_PASSWORD=<strong temporary passphrase; delete after first deploy>
ADMIN_NAME=Your Name
FILE_ENCRYPTION_KEY=<paste output of the 32-byte key command>
GROQ_API_KEY=<your Groq key>
```

## Test configuration

`.env.test` (committed, no secrets) configures `npm test` and `npm run test:e2e`: the `vaultexpiry_test` database, a throwaway encryption key, and a Groq URL pointing at the local mock. **The test database is truncated on every run.**
