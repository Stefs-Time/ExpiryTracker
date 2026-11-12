# VaultExpiry

A clean, simple app for tracking when things expire: driver's licence, firearm licence and competency certificate, car licence disc, bank cards, passport/ID, insurance, subscriptions. It shows what needs attention now and what's coming up, and sends a reminder before each item expires.

- **Dashboard:** a summary banner, KPI tiles (critical / soon / healthy), filters, search, and one card per item with a countdown.
- **Light and dark themes:** follows the OS by default; the header toggle cycles System → Light → Dark.
- **User accounts:** sign up, sign in, password reset by email, change password, delete account.
- **Renewals:** "Mark as renewed" suggests the next expiry date from the item's validity cycle (you can edit it) and keeps a renewal history.
- **Renewal lead time per item:** some renewals take months (e.g. firearm licences: apply at least 90 days before). Cards show "Renewal window open" once you're inside that lead time.
- **Status report:** on-screen table, plain-text copy, print/PDF, CSV export.
- **Reminders:** an email digest when items enter their lead-time, "expiring soon", critical or final-week windows, and once after expiry. Each stage is sent once per expiry date.
- **Calendar sync:** a private subscription link (Google, Apple, Outlook) or a one-off `.ics` download. Events include native alarms at the lead time, 7 days before, and on the day.
- **PWA:** installable, works offline as a read-only copy of your last synced data, and prompts when an update is available.
- **Data portability:** JSON export/import and CSV export.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 22 (ES modules) |
| Server | Express 5, helmet, express-session + connect-pg-simple, express-rate-limit, zod |
| Database | PostgreSQL 13+ (tested on 16) |
| Passwords | Argon2id (OWASP parameters) |
| Email | nodemailer (any SMTP provider), optional |
| Frontend | Semantic HTML, hand-written CSS design tokens, vanilla JS modules. No build step and no CDN. |
| Icons | Lucide (ISC), bundled as a local SVG sprite |
| Tests | `node:test` + supertest against a real PostgreSQL database |

The frontend is self-hosted with a strict Content Security Policy (`script-src 'self'`, `style-src 'self'`). The original mockup loaded the Tailwind Play CDN and `lucide@latest` at runtime. The Play CDN is not meant for production, and an unpinned `@latest` script can't be used under a strict CSP or offline. The mockup's visual design is reproduced in `public/css/app.css` instead; the original is kept in `docs/design/original-mockup.html`.

## Project structure

```
src/
  server.js              # entrypoint: migrate → listen → reminder scheduler → graceful shutdown
  app.js                 # Express app: security headers, static files, sessions, API routes
  config.js              # env validation (fails fast)
  db/pool.js             # pg pool, DATE-as-string parser, withTransaction()
  db/migrate.js          # forward-only SQL migrations with an advisory lock
  db/migrations/*.sql
  middleware/            # auth (session/user loading), CSRF/origin checks, error handler
  routes/                # auth, items, account, reports
  services/              # users, items, calendar (ICS), mailer, reminders
  lib/                   # errors, zod schemas, tokens, logger
public/
  index.html, css/app.css, icons.svg, sw.js, manifest.webmanifest, icons/
  js/app.js              # boot, router, auth forms, theme, service worker
  js/dashboard.js        # banner, KPIs, cards, dialogs, report
  js/settings.js         # settings page
  js/shared/expiry.js    # domain logic shared by server AND browser (single source of truth)
scripts/                 # seed-demo, icon sprite builder, PWA icon renderer
test/                    # unit + API integration tests
docs/                    # API reference, architecture & security notes, original mockup
```

## Local development

Prerequisites: Node.js 22+, PostgreSQL 13+.

```bash
npm install
```

```bash
cp .env.example .env    # then edit DATABASE_URL and SESSION_SECRET
```

```bash
createdb vaultexpiry
```

```bash
npm run dev             # http://localhost:3000 (migrations run automatically on start)
```

Optional demo account with sample items (refuses to run in production):

```bash
npm run seed:demo       # demo@vaultexpiry.local / demo-password-123
```

Without SMTP configured, development logs password-reset links and reminder emails to the console.

### Commands

| Command | Purpose |
|---|---|
| `npm start` | Production start (runs pending migrations first) |
| `npm run dev` | Start with `--watch` and `.env` |
| `npm run migrate` | Apply migrations only |
| `npm test` | Unit + integration tests (uses `.env.test`, needs a test database) |
| `npm run seed:demo` | Create or refresh the demo account |
| `npm run icons` | Rebuild `public/icons.svg` after changing the icon list |

### Tests

The tests run against a real database named in `.env.test` (default `postgres://vault:vault@localhost:5432/vaultexpiry_test`). **All tables in it are truncated**, so don't point it at real data.

```bash
createdb vaultexpiry_test && npm test
```

They cover expiry maths (month-end clamping, timezones, thresholds), auth (signup, login, lockout, reset, session revocation), CSRF/origin enforcement, per-user isolation, validation, filters, renew/history, import, CSV formula-injection escaping, ICS output, calendar tokens, settings, export/delete, and reminder de-duplication. CI runs them on every push (`.github/workflows/ci.yml`).

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | – | Railway supplies this when you reference the Postgres service |
| `SESSION_SECRET` | yes | – | ≥ 32 random chars. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `APP_URL` | yes in production | `http://localhost:$PORT` | Public URL, no trailing slash. Used in emails, calendar links and the origin check |
| `NODE_ENV` | recommended | `development` | Set `production` on Railway (secure cookies, HSTS) |
| `PORT` | no | `3000` | Railway sets this automatically |
| `DATABASE_SSL` | no | `false` | `true` when connecting over a TLS-required public URL. Encrypts but does not verify the certificate; prefer Railway private networking |
| `DATABASE_POOL_MAX` | no | `10` | Keep (replicas × pool) under your Postgres connection limit |
| `TRUST_PROXY` | no | `1` | Number of proxy hops in front of the app (Railway: 1) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | no | – | Needed for password reset and reminder emails |
| `REMINDERS_ENABLED` | no | `true` | Turn the hourly reminder job off for this instance |
| `SIGNUP_ENABLED` | no | `true` | `false` closes public registration |

## Deploying to Railway

1. Create a project, add a **PostgreSQL** service, then add this repo as a service.
2. In the app service's **Variables**, set:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference variable; uses private networking)
   - `SESSION_SECRET` = a long random string
   - `NODE_ENV` = `production`
   - `APP_URL` = your public domain, e.g. `https://vaultexpiry.up.railway.app`
   - SMTP variables, if you want reminders and password resets (e.g. Resend, Postmark, SES, Brevo)
3. Generate a public domain under **Settings → Networking**.
4. Deploy. `railway.json` sets the start command (`npm start`), the `/healthz` health check, and the restart policy. Railway detects Node from `package.json` (`engines.node`) and installs with `npm ci`.
5. Migrations run on boot, guarded by a PostgreSQL advisory lock, so replicas can't race. You can also run them on their own with `npm run migrate`.

**Operational notes**
- **Sessions** live in Postgres, so restarts and redeploys don't sign anyone out, and multiple replicas work.
- **Rate limits** are in-memory per instance. With more than one replica, the effective limit is multiplied; use a shared store if that matters.
- **The reminder job** runs hourly inside the app. A Postgres advisory lock means only one replica sends at a time, and `reminder_log` prevents duplicate emails. Emails go out after 07:00 in each user's timezone.
- **Backups:** turn on Railway Postgres backups (or schedule `pg_dump`). The container filesystem is ephemeral, and the app stores nothing on disk.
- **Shutdown:** on SIGTERM the server stops accepting connections, drains, closes the pool, and exits within 10 s.

## PWA notes

- Installable on Android/desktop (Chrome/Edge) and iOS ("Add to Home Screen"). Needs HTTPS in production; `localhost` is exempt.
- **Offline:** the app shell is precached. Your last-loaded items, account and session responses are cached for **read-only** offline viewing, and edits are disabled while offline. Sign-in, sign-out and session expiry clear that cache.
- **Updates:** bump `VERSION` in `public/sw.js` whenever you change a shell file. Users then see "A new version is available → Refresh".

## Known limitations / roadmap

- No email verification on sign-up yet (a reset link still only reaches the owner's inbox).
- No 2FA/passkeys yet. WebAuthn would be the natural next step.
- No web push notifications (email and calendar alarms cover reminders). Adding push needs VAPID keys and the `web-push` package.
- Offline mode is read-only; there is no offline edit queue.
- Status thresholds are per user, not per category.

See [`docs/API.md`](docs/API.md) for the REST API and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for design and security notes.
