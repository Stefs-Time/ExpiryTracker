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
- **Platform admin console:** see every account, send password resets, unlock, sign out everywhere, disable/enable, delete. Admins **cannot** see anyone's tracked items. Every action is audit-logged. See [Platform admin](#platform-admin).
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
  server.js              # entrypoint: migrate → admin bootstrap → listen → reminder scheduler → graceful shutdown
  app.js                 # Express app: security headers, static files, sessions, API routes
  config.js              # env validation (fails fast)
  db/pool.js             # pg pool, DATE-as-string parser, withTransaction()
  db/migrate.js          # forward-only SQL migrations with an advisory lock
  db/migrations/*.sql
  middleware/            # auth (session/user/admin), CSRF/origin checks, error handler
  routes/                # auth, items, account, reports, admin
  services/              # users, items, admin, calendar (ICS), mailer, reminders
  lib/                   # errors, zod schemas, tokens, logger
public/
  index.html, css/app.css, icons.svg, sw.js, manifest.webmanifest, icons/
  js/app.js              # boot, router, auth forms, theme, service worker
  js/dashboard.js        # banner, KPIs, cards, dialogs, report
  js/settings.js         # settings page
  js/admin.js            # admin console
  js/shared/expiry.js    # domain logic shared by server AND browser (single source of truth)
scripts/                 # seed-admin, seed-demo, icon sprite builder, PWA icon renderer
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

```bash
npm run admin:seed -- --email you@example.com    # create your platform admin (prompts for a password)
```

Optional demo account with sample items (refuses to run in production):

```bash
npm run seed:demo       # demo@vaultexpiry.local / demo-password-123
```

Without SMTP configured, development logs password-reset links and reminder emails to the console.

### Commands

| Command | Purpose |
|---|---|
| `npm start` | Production start (runs pending migrations and the optional admin bootstrap first) |
| `npm run dev` | Start with `--watch` and `.env` |
| `npm run migrate` | Apply migrations only |
| `npm run admin:seed -- --email <addr> [--name "Name"] [--reset-password] [--demote]` | Create, promote, re-password or demote a platform admin |
| `npm test` | Unit + integration tests (uses `.env.test`, needs a test database) |
| `npm run seed:demo` | Create or refresh the demo account |
| `npm run icons` | Rebuild `public/icons.svg` after changing the icon list |

### Tests

The tests run against a real database named in `.env.test` (default `postgres://vault:vault@localhost:5432/vaultexpiry_test`). **All tables in it are truncated**, so don't point it at real data.

```bash
createdb vaultexpiry_test && npm test
```

They cover expiry maths (month-end clamping, timezones, thresholds), auth (signup, login, lockout, reset, session revocation), CSRF/origin enforcement, per-user isolation, validation, filters, renew/history, import, CSV formula-injection escaping, ICS output, calendar tokens, settings, export/delete, reminder de-duplication, and the admin console: access control, the privacy boundary (no item contents leak), every admin action, audit logging, self-protection, and seeding rules. CI runs them on every push (`.github/workflows/ci.yml`).

## Railway variables

Set these on the **app service → Variables** tab. In the **Source** column, "Railway" means Railway provides the value, either automatically or through a reference variable; "You" means you set it. Every variable is validated at startup, and the app refuses to boot, with a clear log message, if a required one is missing or malformed.

### Required

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | Railway (reference) | – | `${{Postgres.DATABASE_URL}}` | Paste the reference exactly as shown; Railway resolves it to the private-network URL of your Postgres service. Locally: `postgres://vault:vault@localhost:5432/vaultexpiry` |
| `SESSION_SECRET` | You | – | `kq3V…` (64 chars) | ≥ 32 random characters. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Changing it signs everyone out |
| `NODE_ENV` | You | `development` | `production` | `production` turns on `Secure` cookies and HSTS, and makes `APP_URL` mandatory |
| `APP_URL` | You | `http://localhost:$PORT` (dev only) | `https://vaultexpiry.up.railway.app` | Public URL, **no trailing slash**. Used in emails, calendar-feed links and the CSRF origin check. Required when `NODE_ENV=production`. You can write `https://${{RAILWAY_PUBLIC_DOMAIN}}` |

### Server & database (optional)

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `PORT` | Railway (automatic) | `3000` | – | Don't set it on Railway; the app listens on whatever Railway assigns, bound to `0.0.0.0` |
| `TRUST_PROXY` | You | `1` | `1` | Proxy hops in front of the app. Railway's edge is one hop. Affects client IPs in rate limiting and the audit log |
| `DATABASE_SSL` | You | `false` | `true` | Only for a TLS-required **public** database URL. Encrypts without verifying the certificate. Not needed with the private `${{Postgres.DATABASE_URL}}` |
| `DATABASE_POOL_MAX` | You | `10` | `5` | Connections per instance. Keep `replicas × DATABASE_POOL_MAX` below Postgres `max_connections` (100 by default) |

### Email (optional, needed for reminders and emailed password resets)

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `SMTP_HOST` | You | *(empty: email off)* | `smtp.resend.com` | Any SMTP provider (Resend, Postmark, Amazon SES, Brevo, Mailgun, Google Workspace…) |
| `SMTP_PORT` | You | `587` | `465` | |
| `SMTP_SECURE` | You | `false` | `true` | `true` for implicit TLS (usually port 465); `false` for STARTTLS (587) |
| `SMTP_USER` | You | *(empty)* | `resend` | |
| `SMTP_PASS` | You | *(empty)* | `re_xxxxxxxx` | Store it as a Railway variable, never in git |
| `MAIL_FROM` | You | `VaultExpiry <no-reply@localhost>` | `VaultExpiry <no-reply@yourdomain.co.za>` | Must be a sender your provider has verified |

Without SMTP the app still works: reminder emails aren't sent, a user's "Forgot password" sends nothing, and the admin console gives the admin a one-time reset link to pass on instead.

### Features (optional)

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `REMINDERS_ENABLED` | You | `true` | `false` | Turns off the hourly reminder job on this instance. In production it also stays off when SMTP isn't configured |
| `SIGNUP_ENABLED` | You | `true` | `false` | `false` closes public registration; existing users can still sign in |

### Platform admin bootstrap (optional)

| Variable | Source | Default | Example | Notes |
|---|---|---|---|---|
| `ADMIN_EMAIL` | You | *(empty: no bootstrap)* | `you@yourdomain.co.za` | On boot, creates this admin account **if no account with this email exists** |
| `ADMIN_PASSWORD` | You | *(empty)* | a 20+ character passphrase | 12–128 characters. Only used to create the account. **Delete this variable after the first successful deploy** (the logs warn while it's still set) |
| `ADMIN_NAME` | You | `Platform Admin` | `Stef` | Display name for the new admin |

Booleans accept `true`/`false` (or `1`/`0`). Empty values count as unset.

### Copy-paste starter (Railway → Variables → Raw Editor)

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
ADMIN_PASSWORD=<strong temporary passphrase — delete after first deploy>
ADMIN_NAME=Your Name
```

## Deploying to Railway

1. Create a project, add a **PostgreSQL** service, then add this repo as a service.
2. Generate a public domain under the app service's **Settings → Networking**.
3. Set the variables above (the starter block covers a typical setup).
4. Deploy. `railway.json` sets the start command (`npm start`), the `/healthz` health check, and the restart policy. Railway detects Node from `package.json` (`engines.node`) and installs with `npm ci`.
5. On boot the app runs migrations (guarded by a PostgreSQL advisory lock, so replicas can't race) and then the admin bootstrap. Check the deploy logs for `Platform admin bootstrap … "action":"created"`.
6. Sign in as the admin, then **delete `ADMIN_PASSWORD`** from the variables and change the password in Settings.

**Operational notes**
- **Sessions** live in Postgres, so restarts and redeploys don't sign anyone out, and multiple replicas work.
- **Rate limits** are in-memory per instance. With more than one replica, the effective limit is multiplied; use a shared store if that matters.
- **The reminder job** runs hourly inside the app. A Postgres advisory lock means only one replica sends at a time, and `reminder_log` prevents duplicate emails. Emails go out after 07:00 in each user's timezone.
- **Backups:** turn on Railway Postgres backups (or schedule `pg_dump`). The container filesystem is ephemeral, and the app stores nothing on disk.
- **Shutdown:** on SIGTERM the server stops accepting connections, drains, closes the pool, and exits within 10 s.

## Platform admin

A platform admin manages **accounts**, not vault contents.

| Admins can | Admins cannot |
|---|---|
| List and search every user: name, email, role, status (active / locked / disabled), item **count**, last sign-in, active sessions, join date | See any item's title, reference, note or date |
| See platform stats (users, active users, new sign-ups, total items, reminders sent) | Sign in as a user, or see password hashes or calendar tokens |
| **Send a password reset.** With SMTP, the link goes to the user's inbox and the admin never sees it. Without SMTP, the admin gets a one-time, 60-minute link to pass on | Set a user's password directly |
| **Unlock** an account locked after failed sign-ins | Disable, delete or demote **themselves** |
| **Sign out everywhere** (revokes all sessions) | Delete another **admin** (demote them first, via the CLI) |
| **Disable / enable** an account: blocks sign-in, sessions, reminders, the calendar feed and password resets, but keeps the data | Change anyone's role from the web UI |
| **Delete** an account (must type the user's email to confirm) | |

Every action is written to an append-only `admin_audit` table: who, what, target email, IP and time. The audit log appears at the bottom of the console. Entries survive deletion of the target account.

**Creating admins.** Promotion is deliberately CLI-only, so a compromised admin session can't create more admins.

```bash
npm run admin:seed -- --email you@example.com --name "Your Name"   # create (prompts for password) or promote
```

```bash
npm run admin:seed -- --email you@example.com --reset-password     # set a new password, sign out its sessions
```

```bash
npm run admin:seed -- --email old-admin@example.com --demote       # refuses to remove the last active admin
```

On Railway, run these with the [Railway CLI](https://docs.railway.com/guides/cli) (`railway run npm run admin:seed -- …`), or use the `ADMIN_*` bootstrap variables. The bootstrap only **creates** a missing account. It never promotes an existing one, because with public sign-up anyone could register your admin email before your first deploy. If that email is already registered, the bootstrap logs a warning and does nothing; check the account is yours, then promote it with the CLI.

Note that `railway run` executes on your machine with the service's variables, so it needs a database URL reachable from outside Railway (the Postgres service's public URL, with `DATABASE_SSL=true`). If you'd rather not expose the database, use the bootstrap variables.

## PWA notes

- Installable on Android/desktop (Chrome/Edge) and iOS ("Add to Home Screen"). Needs HTTPS in production; `localhost` is exempt.
- **Offline:** the app shell is precached. Your last-loaded items, account and session responses are cached for **read-only** offline viewing, and edits are disabled while offline. Sign-in, sign-out and session expiry clear that cache.
- **Updates:** bump `VERSION` in `public/sw.js` whenever you change a shell file. Users then see "A new version is available → Refresh".

## Known limitations / roadmap

- No email verification on sign-up yet (a reset link still only reaches the owner's inbox).
- No 2FA/passkeys yet. These matter most for admin accounts; WebAuthn would be the natural next step.
- No web push notifications (email and calendar alarms cover reminders). Adding push needs VAPID keys and the `web-push` package.
- Offline mode is read-only; there is no offline edit queue.
- Status thresholds are per user, not per category.

See [`docs/API.md`](docs/API.md) for the REST API and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for design and security notes.
