# Architecture & security notes

## Shape

A **modular monolith**: one Node.js process serves the static PWA, the JSON API and an hourly reminder job, backed by one PostgreSQL database. There are no queues, caches or extra services. At this scale (personal records, tens of items per user) they would add operational cost without a measured need.

```
Browser (PWA) ──HTTPS──► Railway edge ──► Express
                                            ├─ static /public (shell; SW caches it)
                                            ├─ /api (session → CSRF → routes → services → pg)
                                            ├─ /cal/<token>.ics (token-auth calendar feed)
                                            └─ reminder job (hourly, advisory-locked) ──► SMTP
                                                         │
                                                    PostgreSQL
```

### One source of truth for expiry rules

`public/js/shared/expiry.js` is a pure ES module imported by **both** the server (reports, reminders, renew suggestions, validation) and the browser (rendering, offline view). Status thresholds, day counting, month arithmetic and labels therefore can't drift between client and server.

- Expiry values are **calendar dates** (`DATE` in Postgres, `YYYY-MM-DD` strings in JS). `pg` is configured to return `DATE` as a string; converting it to a JS `Date` shifts it by the server's UTC offset (a classic off-by-one bug).
- "Today" is the user's local date (`users.timezone`, IANA), computed with `Intl.DateTimeFormat`.
- Adding months clamps to month end (31 Jan + 1 month = 28/29 Feb).

## Data model

| Table | Purpose |
|---|---|
| `users` | Account, Argon2id hash, timezone, thresholds, reminder opt-in, calendar-token hash, lockout counters |
| `items` | Tracked items (`user_id` FK, `ON DELETE CASCADE`). Index `(user_id, expiry_date)` serves every list and report query |
| `item_renewals` | Audit trail of renewals |
| `password_resets` | SHA-256 of reset tokens, expiry, used-at |
| `reminder_log` | `(item_id, expiry_date, stage)` primary key, so each reminder stage is sent at most once per expiry date. Renewing creates a new expiry date and re-arms the stages |
| `session` | connect-pg-simple session store |

CHECK constraints mirror the zod validation (lengths, enum, ranges, `warning_days > critical_days`, lowercase email), so bad data can't get in through any code path. Migrations are plain SQL files applied in order, inside transactions, under an advisory lock.

## Security controls

| Concern | Control |
|---|---|
| Passwords | Argon2id (m=19 MiB, t=2, p=1, the OWASP baseline); 10–128 chars, no composition rules (NIST 800-63B); transparent rehash when parameters change |
| Credential stuffing / brute force | Per-IP rate limits on auth endpoints, plus per-account lockout (5 failures → 15 min). Unknown emails take the same Argon2 verification time and get the same error message |
| Sessions | Server-side in Postgres; `HttpOnly`, `SameSite=Lax`, `Secure` in production; ID regenerated at login (prevents fixation); 30-day sliding expiry. Password change/reset deletes all of the user's sessions, and each session is pinned to `password_changed_at` as a backstop |
| CSRF | Layered: SameSite cookie; JSON-only bodies (415 otherwise); `Origin`/`Sec-Fetch-Site` same-origin check; per-session synchronizer token (`X-CSRF-Token`) on authenticated mutations |
| Authorization | Every item query is scoped `WHERE user_id = $session_user`; other users' records return 404, not 403, so their existence isn't revealed. Tested |
| Injection | All SQL is parameterized. Dynamic `ORDER BY` uses a whitelist. `LIKE` wildcards in search are escaped |
| XSS | Strict CSP (`default-src 'self'`; no inline script or style; `object-src 'none'`; `frame-ancestors 'none'`). Every user string rendered via `innerHTML` passes through `esc()`. (The original mockup interpolated titles into `innerHTML` unescaped; that's fixed.) |
| Sensitive data minimisation | References must be masked: values with 10+ consecutive digits (full card or ID numbers) are rejected on both client and server |
| Tokens | Reset and calendar tokens are 256-bit random values; only SHA-256 hashes are stored. Reset tokens are single-use, last 60 min, and each new request invalidates the previous one |
| Enumeration | `/auth/forgot` always returns 202 with the same body |
| CSV export | Formula-injection prefixing (`'=…`) |
| Headers | helmet: CSP, HSTS (production), `nosniff`, `Referrer-Policy: same-origin`, COOP/CORP, `Permissions-Policy` locking camera/mic/geo/payment |
| Caching | `Cache-Control: no-store` on all API responses. The service worker's personal-data cache is deleted on sign-in, sign-out and session expiry |
| Limits | 32 KB JSON bodies (1 MB for import), 1000 items per user, 500 per page, 15 s statement timeout, 30 s request timeout |
| Errors | Clients get stable codes and safe messages; stack traces go only to structured server logs |
| Config | Validated at startup; the process refuses to start without `DATABASE_URL`, a ≥32-char `SESSION_SECRET`, and `APP_URL` in production |

### Accepted risks / follow-ups

- **Calendar feed URLs** are bearer secrets. Anyone holding one can read item titles, references and dates. Users can rotate or revoke them in Settings.
- **Offline cache:** the last item list is stored in the browser's Cache Storage until sign-out. On a shared device, users should sign out.
- **`DATABASE_SSL=true`** encrypts but does not verify the server certificate (Railway's public proxy uses its own certificate). Prefer the private-network `DATABASE_URL`.
- **In-memory rate limits** are per instance.
- **Not yet implemented:** email verification, 2FA/passkeys.

## Frontend

- No framework and no build step: `index.html` + ES modules. The browser loads about 90 KB uncompressed (JS, CSS and the icon sprite).
- Hash routing (`#/`, `#/settings`, `#/login`, `#/signup`, `#/forgot`, `#/reset?token=`), so there's no server-side SPA fallback, and the reset token never reaches server logs as a query string.
- Native `<dialog>` elements for modals (focus handling, Esc to close), `aria-live` regions for the banner and toasts, `aria-pressed` filter buttons, visible focus rings, `prefers-reduced-motion` respected.
- Theme: CSS custom properties on `:root`, dark overrides under `prefers-color-scheme` (unless `data-theme="light"`) and under `[data-theme="dark"]`. A tiny blocking `theme-boot.js` applies the saved choice before first paint.
- Keyboard shortcuts on the dashboard: `n` = new item, `/` = search.
