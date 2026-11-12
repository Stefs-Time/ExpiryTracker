# VaultExpiry REST API

Base path: `/api`. JSON in, JSON out. Authentication uses an HttpOnly session cookie (`vx.sid`).

## Conventions

**Success**

```json
{ "success": true, "data": { }, "meta": { } }
```

**Error**

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Use a valid date (YYYY-MM-DD)", "details": [{ "field": "expiryDate", "message": "…" }] } }
```

| Status | Code(s) | When |
|---|---|---|
| 400 | `BAD_REQUEST`, `INVALID_TOKEN` | Malformed JSON; invalid or expired reset token |
| 401 | `UNAUTHORIZED` | Not signed in, wrong credentials, or the session was revoked |
| 403 | `FORBIDDEN`, `SIGNUP_DISABLED`, `ACCOUNT_DISABLED` | CSRF / origin check failed; not an admin; sign-up closed; account disabled by an admin (shown only after a correct password) |
| 404 | `NOT_FOUND` | Unknown resource, or one that belongs to another user |
| 409 | `CONFLICT`, `LIMIT_REACHED` | Email already registered; more than 1000 items |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 32 KB (1 MB for import) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Mutating request body that isn't `application/json` |
| 422 | `VALIDATION_ERROR` | Input failed validation (see `details`) |
| 429 | `RATE_LIMITED`, `ACCOUNT_LOCKED` | Too many requests; 5 failed logins lock the account for 15 min |
| 500 | `INTERNAL_ERROR` | Unexpected error. Details are logged, never returned |

**CSRF:** every `POST/PATCH/DELETE` from a signed-in session must send `X-CSRF-Token: <csrfToken>`. The token comes back from `signup`, `login`, `reset`, `me` and `account/password`. Requests must also be same-origin (`Origin` / `Sec-Fetch-Site`) and send JSON bodies.

**Dates:** expiry dates are calendar dates, `YYYY-MM-DD`. "Today" is computed in the user's timezone setting.

## Item object

```json
{
  "id": "uuid",
  "title": "Driver's licence card (Code B)",
  "category": "License",
  "ref": "DL •••• 8834",
  "expiryDate": "2026-12-04",
  "cycleMonths": 60,
  "leadDays": 60,
  "note": "Eye test & DLTC booking required",
  "createdAt": "2026-11-12T07:46:12.326Z",
  "updatedAt": "2026-11-12T07:46:12.326Z"
}
```

| Field | Rules |
|---|---|
| `title` | 1–120 chars, required |
| `category` | `Vehicle`, `License`, `Firearm`, `Banking`, `Identity`, `Insurance`, `Medical`, `Subscription`, `Other` |
| `ref` | ≤ 40 chars, masked only: anything with 10+ consecutive digits (spaces/dashes ignored) is rejected |
| `expiryDate` | Valid ISO date, 1900–2200 |
| `cycleMonths` | 1–240 (default 12); used to suggest the next expiry on renewal |
| `leadDays` | 0–365 (default 30); start-renewal window, reminder and calendar alarm |
| `note` | ≤ 500 chars |

Status is derived, not stored. `critical`: days left ≤ `criticalDays` (includes expired). `soon`: ≤ `warningDays`. `valid`: otherwise.

## Auth — `/api/auth`

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/config` | – | `{ signupEnabled }` |
| POST | `/signup` | `{ email, password (10–128), displayName, timezone? }` | 201 `{ user, csrfToken }`, signed in |
| POST | `/login` | `{ email, password }` | 200 `{ user, csrfToken }` |
| POST | `/logout` | – | 204 |
| GET | `/me` | – | `{ user, csrfToken }` or 401 |
| POST | `/forgot` | `{ email }` | Always 202 (no account enumeration). Emails a 60-minute single-use link |
| POST | `/reset` | `{ token, password }` | 200 `{ user, csrfToken }`. Revokes all other sessions |

Rate limits per IP: login 10 per 15 min, signup 5 per hour, forgot/reset 5 per hour, everything else 300 per minute.

## Items — `/api/items` (auth)

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Query: `q` (≤100), `category`, `status` (`critical`/`soon`/`valid`), `sort` (`expiry`, `-expiry`, `title`, `created`), `page` (≥1), `limit` (1–500, default 100). `meta`: `{ page, limit, total, totalPages, today }` |
| POST | `/` | Create, returns 201 + `Location` header |
| GET | `/:id` | 404 if it isn't yours |
| PATCH | `/:id` | Any subset of item fields |
| DELETE | `/:id` | 204. **Soft delete:** the item, its photos and its history disappear from every endpoint immediately, can be restored for 60 minutes, and are then permanently purged |
| POST | `/:id/restore` | Undo a delete within 60 minutes → 200 with the original item (same id, photos, history). 410 `GONE` after the window, or if the item isn't yours |
| POST | `/:id/renew` | `{ newExpiryDate? }`. Without a date: one cycle after the current expiry, or after today if already expired. Records history |
| GET | `/:id/renewals` | Last 50 renewals `{ previousExpiry, newExpiry, renewedAt }` |
| POST | `/import` | `{ items: [ … ≤ 500 ] }` → `{ imported, skipped }`. Skips items whose title, category and expiry date match an existing one. Accepts the `items` array from `/account/export` |

## Photos & AI scan (auth)

Photo uploads send the **raw JPEG bytes** as the request body with `Content-Type: image/jpeg`. The same-origin and `X-CSRF-Token` rules still apply. Non-JPEG or malformed files get 422 `INVALID_IMAGE`; other content types get 415. EXIF/XMP/IPTC metadata is stripped on the server.

| Method | Path | Body | Result |
|---|---|---|---|
| PUT | `/api/account/scan-consent` | `{ consent: true \| false }` | Updated user (`aiScanConsent`) |
| POST | `/api/scan` | JPEG (≤ 4 MB) | `{ suggestion: { title, category, ref, expiryDate \| null, cycleMonths, leadDays }, confidence (0–1), notes, found: { expiryDate, issueDate, reference } }`. **Not stored.** 403 `CONSENT_REQUIRED` without consent; 503 `FEATURE_DISABLED` without `GROQ_API_KEY`; 422 `SCAN_UNREADABLE`; 429 `SCAN_BUSY` / `RATE_LIMITED` (30 per user per hour); 502/504 `SCAN_UNAVAILABLE` |
| GET | `/api/items/:id/attachments` | – | `[{ id, itemId, label, contentType, byteSize, width, height, createdAt, url }]` |
| POST | `/api/items/:id/attachments?label=front\|back\|other` | JPEG (≤ 4 MB) | 201 with metadata. 409 `LIMIT_REACHED` (4 per item, 100 MB per user) |
| GET | `/api/items/:id/attachments/:aid` | – | The decrypted `image/jpeg`, with `Cache-Control: private, no-store` |
| DELETE | `/api/items/:id/attachments/:aid` | – | 204 |

Every attachment route returns 404 for items or photos that aren't yours, and 503 `FEATURE_DISABLED` without `FILE_ENCRYPTION_KEY`. Item objects include `attachmentCount`. `/api/auth/config` and `/api/account` report `scanEnabled` / `attachmentsEnabled`. `/api/account` also reports `aiScanConsent` and `photoStorage: { photos, bytes, limitBytes }`. `/api/account/export` lists photo metadata and URLs, not the image bytes.

## Reports — `/api/reports` (auth)

| Method | Path | Result |
|---|---|---|
| GET | `/status` | `{ today, counts: { total, critical, soon, valid, expired }, items: [item + daysLeft, status, label, expired, remainingPct, renewalWindowOpen] }`, most urgent first |
| GET | `/status.csv` | CSV download (UTF-8 BOM; cells starting `= + - @` are prefixed with `'` to stop spreadsheet formula injection) |
| GET | `/status.txt` | Plain-text summary |
| GET | `/calendar.ics` | iCalendar download |

## Account — `/api/account` (auth)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/` | – | Profile + `mailConfigured` |
| PATCH | `/` | Any of `displayName`, `timezone` (IANA), `criticalDays` (1–365), `warningDays` (2–730, must be > critical), `emailReminders` | Updated profile |
| POST | `/password` | `{ currentPassword, newPassword }` | `{ csrfToken }`. This session stays signed in; all others are revoked |
| POST | `/calendar-token` | – | 201 `{ url }`, shown once. Replaces any previous link |
| DELETE | `/calendar-token` | – | 204 |
| GET | `/export` | – | JSON download of the account and all items |
| DELETE | `/` | `{ password }` | 204. Deletes the account, items, history and sessions |

## Admin — `/api/admin` (platform admins only)

Requires a signed-in user with `role = 'admin'`. The role is read from the database on every request. Non-admins get 403, anonymous callers 401. Mutations follow the same CSRF rules, plus a limit of 60 per minute per IP. **No admin endpoint returns item contents**, only counts. Every mutation writes to the audit log.

Admin user object:

```json
{
  "id": "uuid", "email": "bob@example.com", "displayName": "Bob", "role": "user",
  "status": "active | locked | disabled", "createdAt": "…", "lastLoginAt": "…", "disabledAt": null,
  "lockedUntil": null, "failedLogins": 0, "emailReminders": true, "timezone": "Africa/Johannesburg",
  "itemCount": 6, "activeSessions": 2
}
```

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/stats` | – | `{ users, admins, disabled, newLast30Days, activeLast30Days, items, remindersLast30Days, mailConfigured }` |
| GET | `/users` | `q` (name/email), `status` (`active`/`locked`/`disabled`), `role` (`user`/`admin`), `sort` (`created`, `-created`, `email`, `lastLogin`), `page`, `limit` (1–200, default 50) | Admin user objects + pagination `meta` |
| GET | `/users/:id` | – | Admin user object |
| POST | `/users/:id/password-reset` | – | With SMTP: emails the user, returns `{ emailed: true }`. Without SMTP: `{ emailed: false, link, expiresInMinutes: 60 }`. 409 if the account is disabled |
| POST | `/users/:id/unlock` | – | Clears failed-login lockout |
| POST | `/users/:id/sign-out` | – | Revokes all of the user's sessions |
| POST | `/users/:id/disable` | – | Blocks sign-in, sessions, reminders, calendar feed and resets. 403 on yourself, 409 if already disabled |
| POST | `/users/:id/enable` | – | 409 if not disabled |
| DELETE | `/users/:id` | `{ confirmEmail }` (must match the user's email) | 204. 403 on yourself or another admin |
| GET | `/audit` | `page`, `limit`, `userId?` | `[{ id, adminEmail, action, targetUserId, targetEmail, ip, createdAt }]`, newest first |

Role changes are not available over HTTP. Use `npm run admin:seed` (see README).

## Public endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | `{ status: "ok" }` (checks the DB) or 503 |
| GET | `/cal/<token>.ics` | Private calendar feed. The token is 256-bit random and only its SHA-256 is stored. 30 requests per minute per IP |
