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
| 403 | `FORBIDDEN`, `SIGNUP_DISABLED` | CSRF / origin check failed; sign-up closed |
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
| DELETE | `/:id` | 204 |
| POST | `/:id/renew` | `{ newExpiryDate? }`. Without a date: one cycle after the current expiry, or after today if already expired. Records history |
| GET | `/:id/renewals` | Last 50 renewals `{ previousExpiry, newExpiry, renewedAt }` |
| POST | `/import` | `{ items: [ … ≤ 500 ] }` → `{ imported, skipped }`. Skips items whose title, category and expiry date match an existing one. Accepts the `items` array from `/account/export` |

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

## Public endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | `{ status: "ok" }` (checks the DB) or 503 |
| GET | `/cal/<token>.ics` | Private calendar feed. The token is 256-bit random and only its SHA-256 is stored. 30 requests per minute per IP |
