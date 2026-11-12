# Testing

| Suite | Command | What it runs | Typical time |
|---|---|---|---|
| Lint | `npm run lint` | ESLint (recommended rules plus hygiene rules) over the whole repo | ~1 s |
| Unit + API | `npm test` | `test/*.test.js` with `node:test` and supertest against a real PostgreSQL database | ~7 s |
| Coverage | `npm run test:coverage` | The same, with a coverage report; **fails below 90% lines / 78% branches** | ~7 s |
| End-to-end | `npm run test:e2e` | `e2e/*.e2e.js`: starts the real server, a mock Groq API and headless Chromium | ~16 s |
| Everything CI runs | `npm run check` then `npm run test:e2e` | | |

CI (`.github/workflows/ci.yml`) runs two jobs on every push and pull request:
- **lint + coverage + `npm audit`** (production dependencies, high severity);
- **end-to-end**, which installs Chromium.

## Setup

Both suites use the database in `.env.test` (default `postgres://vault:vault@localhost:5432/vaultexpiry_test`). **All tables are truncated on each run**, so never point it at real data.

```bash
createdb vaultexpiry_test
```

```bash
npx playwright install chromium    # once, for the end-to-end suite
```

No real email, SMTP or Groq access is needed:
- **Email:** in `NODE_ENV=test`, emails go to an in-memory `outbox` (`src/services/mailer.js`). `testControls.failNextSends` simulates SMTP failures.
- **Groq:** the API tests run a mock on `127.0.0.1:47999`, and the end-to-end harness runs its own on `:47997`. Both are switchable between OK, missing-date, unreadable and error replies.
- **Rate limits** are skipped in test mode unless `TEST_RATE_LIMIT=1`.

## What's covered

**Unit + API (`test/`):**

| File | Covers |
|---|---|
| `expiry.test.js` | Date maths: month-end clamping, leap days, DST, timezones, status thresholds, reminder stages |
| `api.test.js` | Auth (sign-up, login, lockout, enumeration, reset), CSRF/origin/content-type, per-user isolation, validation, filters, renew/history, import, reports (CSV injection, ICS folding), calendar tokens, settings, password change, export/delete, reminder de-duplication |
| `admin.test.js` | Admin access control, the privacy boundary (no item contents or secrets leak), every admin action, audit log, self-protection, seeding rules |
| `media.test.js` | JPEG sanitising (EXIF/GPS stripped), scan normalising and masking, consent, Groq request shape, provider errors, encryption at rest, owner-only photo access, limits, export |
| `robustness.test.js` | Soft delete/restore/purge, reminders skipping deleted items, reminder retry after a mail failure, provider network failure, malformed/oversized bodies, request IDs, JPEG edge cases |

**End-to-end (`e2e/app.e2e.js`):**
- **Core journeys:** sign-up, add, edit, renew, delete + undo, filters, report copy, CSV.
- **Photo scanning:** consent, prefill, decline, missing date, provider error.
- **Photos and admin:** photo save, view and delete; admin access and redirects.
- **Quality checks:**
  - **zero axe-core WCAG 2.2 AA violations** on six screens in light and dark themes;
  - no horizontal overflow at 320/375/768 px;
  - accessible names on the mobile header;
  - focus restored after saving;
  - a visible skip link.

Accessibility scans run with `prefers-reduced-motion: reduce` so they never catch a dialog mid-fade.

## Writing tests

- **API tests:** use the helpers in `test/helpers.js`:
  - `signUp(app)` returns an agent with CSRF-aware `post` / `patch` / `del`;
  - `sampleItem()` builds a valid item.
  - Create users with unique emails; tests share one database per file.
- **End-to-end tests:** use `e2e/harness.js`:
  - `newPage()`, `signUpVia()`, `addItem()` and `axe()`;
  - `groq.mode` to change the mock reply.
  - Prefer waiting for selectors over fixed sleeps.
- **Fixtures:** `test/fixtures/card.jpg` and `card-exif.jpg`. The second has a fake GPS marker, used to prove metadata stripping.
- **Behaviour changes need tests.** When you change behaviour, update or add tests in the same change. The coverage gate catches untested new code paths.
