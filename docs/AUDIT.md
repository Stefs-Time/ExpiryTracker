# VaultExpiry — quality audits

Two audit rounds, newest first. Round 1 covered the core app and admin console. Round 2 re-tested everything and added the photo/AI-scan features, security and privacy probes, performance at volume, and test coverage.

---

# Round 2 — full UI, UX, UAT & testing audit (with fixes)

**Date:** 12 Nov 2026 · **Build audited:** `a4cf4c7` (after document photos + AI scan) · **Re-tested after fixes:** same day

## Method

| Area | What was done |
|---|---|
| Regression | Re-ran all round-1 suites: axe-core on 22 screen/theme combinations, 29 UAT scenarios, keyboard walkthrough, responsive 320–1440 px, admin console |
| New UAT | 11 photo/scan scenarios against a mock Groq with switchable responses (ok / no expiry / unreadable / HTTP 500 / 429): consent decline, non-image files, 24 MP photos, provider failures, edit-mode scans, undo with photos, keyboard use, photo limits, offline |
| Security & privacy | Photo response headers, admin access to photos, log hygiene (image bytes or extracted values in logs), production-mode safety |
| Performance | 500 items imported: API latency and payload, full render, search |
| Testing | Coverage measured with `node --test --experimental-test-coverage`; untested paths identified and covered |

Results were cross-checked before being reported. Four apparent failures came from my measurement scripts, not the app (photo size read from a Blob body, programmatic vs. keyboard focus, a duplicate card title, and polling overhead in a timing test). Each was re-verified directly (database row, real Tab focus, in-page timer) and passed.

## Results

| Metric | Before round 2 | After fixes |
|---|---|---|
| UAT scenarios (round 1 + photo) | 29/29 + 8/11 photo | **29/29 + 11/11** |
| axe-core violations (all screens incl. photo UI, both themes) | 0 | **0** |
| Automated tests | 57 (API/unit) | **67 API/unit + 10 end-to-end** |
| Line / branch coverage | 93.2% / 81.4% | **94.0% / 82.5%**, enforced in CI (≥ 90% / ≥ 78%) |
| 500-item load | API 21 ms (138 KB), render 188 ms, search 174 ms | unchanged |
| Horizontal overflow, 320–1440 px | none | none |

## Findings and fixes

| ID | Area | Sev. | Finding | Fix |
|---|---|---|---|---|
| R2-01 | UX / data | **High** | **Undo after delete lost the item's photos** and renewal history. Undo re-created a new item, and the photos had already been deleted with the original. The confirm text didn't mention photos | **Soft delete.** `DELETE` marks the item deleted, and Undo calls `POST /items/:id/restore`, which brings back the original (same ID, photos, history) within 60 minutes. A 10-minute maintenance job then purges it permanently. The confirm text now names the photos. Every query (lists, reports, calendar, reminders, export, admin counts, photo access) excludes deleted items |
| R2-02 | UX | **High** | **At the 4-photo limit,** the dialog still offered to save the photo. The upload failed, and the "Updated" success message **overwrote the error**, so users weren't told their photo wasn't saved | Dialog knows the item's photo count: it hides "Save this photo" and explains the limit, and deleting a photo frees the slot. Upload failures are returned to the caller, which shows **one** message, and errors take priority |
| R2-03 | UX / data | Medium | When a scan found **no expiry date**, the form kept the placeholder date (today + 1 year), so a skimming user could save a wrong date | New items: the placeholder is cleared and marked invalid, focus moves to the date, and Save asks for one. When editing, the existing date is kept |
| R2-04 | Security | Medium | `NODE_ENV` defaulted to `development`. **Forgetting it on Railway** would have shipped non-`Secure` session cookies and **written email bodies (incl. reset links) to logs** | On Railway, `NODE_ENV` defaults to `production`. Startup then also requires `APP_URL`, failing loudly instead of running insecurely |
| R2-05 | UX | Medium | Typed item details were **lost when a session expired** mid-edit (round-1 R-03) | The open form is stashed in this tab's `sessionStorage`, tied to the user and kept for up to 2 hours. After signing in again, a "Restore" prompt reopens it. Never shown to a different account |
| R2-06 | Ops | Low | Expired and used **password-reset tokens accumulated** forever | Purged by the maintenance job |
| R2-07 | Testing | Medium | Untested paths: **reminder retry after a mail failure**, AI provider network failure, malformed JSON / oversized bodies, unusual JPEG structures; no committed browser tests | 10 new API tests (incl. a test-only SMTP failure hook proving claims are released and retried), plus a committed **end-to-end suite** (`e2e/`, Playwright + axe-core) as its own CI job |
| R2-08 | Testing | Low | An early run of the new end-to-end accessibility scan reported a contrast failure that turned out to be the dialog's fade-in animation (4.42:1 mid-fade, passes when settled) | End-to-end tests run with `prefers-reduced-motion: reduce`, which the CSS honours, so scans are deterministic |

### Verified working (round 2)

- **Photo scanning:**
  - Declining consent sends nothing to Groq and keeps the photo.
  - Non-images get a friendly message.
  - A 6000×4000 photo is stored at 2000×1333, 129 KB.
  - Unreadable photos, HTTP 500 and 429 responses each get a specific next-step message, and the photo is kept.
  - Edit-mode scans change only the expiry date and reference.
- **Keyboard:** the photo button is keyboard-operable with a visible focus ring.
- **Photo labels:** the photo icon and viewer images have meaningful names ("View 1 photo of …", "Front of …").
- **Offline:** adding is blocked with a clear message.
- **Photo responses:** `private, no-store`, `nosniff`, `CORP same-origin`. The platform admin gets **404** for a user's photo.
- **Logs:** in production mode they contain no image data or extracted values. Request logs record paths only, and scan logs record model, latency, tokens and outcome.

### Still open (carried forward)

From round 1, still open: R-01 (admin 2FA/passkeys), R-02 (real screen readers and iOS Safari), R-05 (email verification), R-06 (admin audit filters / CSV export / user notifications), R-07 (disable buttons while offline), R-08 (manifest screenshots), R-09 (anonymous `/auth/me` 401 console noise), R-10 (report table caption). New in round 2:

| ID | Sev. | Recommendation |
|---|---|---|
| R2-R1 | High | **Test the real Groq model** on real South African documents (driver's licence card, licence disc, firearm licence, bank cards) and tune the prompt. Everything so far used a mock |
| R2-R2 | Medium | Read the **back** of a card in the same scan (Groq allows up to 3 images per request) |
| R2-R3 | Medium | `FILE_ENCRYPTION_KEY` **rotation** script (re-encrypt with a new key; `key_version` column already present) |
| R2-R4 | Low | A "Recently deleted" view, so restore isn't only possible from the Undo prompt |

Closed from round 1: **R-03** (draft lost on session expiry → R2-05) and **R-04** (Undo restores the original item → R2-01).

---

# Round 1 — UAT, UA, UI, UX & EX audit

**Date:** 12 Nov 2026 · **Build audited:** `claude/elegant-feynman-hk2nui` (after the platform-admin commit) · **Re-tested after fixes:** same day

## Scope and method

| Audit | Meaning here | How it was tested |
|---|---|---|
| **UAT**: user acceptance testing | Can real users complete the jobs the app exists for? | 29 scripted end-to-end scenarios in Chromium (Playwright) against the running app and a real PostgreSQL database |
| **UA**: usability & accessibility | WCAG 2.2 AA conformance and keyboard/screen-reader use | axe-core 4.14 on 11 screens/dialogs × 2 themes (22 scans), a keyboard-only walkthrough, touch-target measurement |
| **UI**: user interface | Visual consistency, responsiveness, theming, print | Screenshots at 320 / 375 / 768 / 1024 / 1440 px in light and dark; overflow detection; print-media render |
| **UX**: user experience | Flow friction, feedback, error recovery, microcopy | Same scenarios, reviewed for copy quality, focus behaviour, recovery paths and edge cases |
| **EX**: operator & edge-case experience | What admins and operators experience; how the app behaves when things go wrong | Admin console walkthrough, session expiry, Back-button, double-submit, offline, log inspection |

Not covered: real iOS Safari or Android devices (Chromium emulation only), real screen readers (NVDA, VoiceOver), real SMTP delivery, and load testing.

## Results summary

| Metric | Before | After fixes |
|---|---|---|
| UAT scenarios passing | 23 / 29* | **29 / 29** |
| axe-core violations (rules failing, both themes) | 3 rules, 200+ nodes | **0** |
| Horizontal overflow (320–1440 px) | Overflow at 320 px | **None** |
| Keyboard focus lost after save/delete/sign-in | Yes | **No** |
| PWA installability errors (Chrome) | 0 | 0 |
| Automated test suite | 47 / 47 | 47 / 47 |

\* Three of the initial failures were mistakes in my test scripts (wrong expected counts after an earlier renewal; an out-of-band logout correctly rejected by CSRF protection; a navigation race). Once corrected, those scenarios passed with no app change. The other failures were real and are fixed below.

## Findings

Severity: **Critical** blocks a user group or breaks a core journey · **High** a WCAG AA failure or a likely-to-hit defect · **Medium** noticeable friction or partial non-conformance · **Low** polish.

### Fixed in this pass

| ID | Area | Sev. | Finding | Evidence | Fix |
|---|---|---|---|---|---|
| A-01 | UA | **Critical** | Below 480 px, the header "Status report" and "Add item" buttons had **no accessible name**; screen readers announced just "button" | Keyboard audit: accessible text empty at 375 px | Labels are visually hidden but still read on small screens (WCAG 4.1.2) |
| A-02 | UA | **High** | **Colour contrast** failed WCAG 1.4.3 in both themes: secondary ("faint") text 3.06–4.05:1, the light-theme primary button 3.76:1, the dark-theme danger button 3.67:1 | axe `color-contrast` on every screen (up to 17 nodes per page) | Re-tokenised by calculation: light faint `#5b6b80` (≥4.8:1), light muted `#475569`, dark faint `#8b97aa` (≥5.9:1), primary `#047857` (5.5:1), danger `#e11d48` (4.7:1) |
| U-01 | UI | **High** | At 320 px, item **cards overflowed the screen**; the delete button was cut off | Overflow detector: 28 px; screenshot | Grid tracks `minmax(0, 1fr)`; cards may shrink; category label truncates |
| X-01 | EX | **High** | When a **session expired with a dialog open**, the dialog stayed on top of the sign-in screen showing "Authentication required" | UAT-26 screenshot | Every route change closes open dialogs |
| U-02 | UI/UX | **High** | **Toasts rendered behind modal dialogs** (blurred under the backdrop), e.g. "Report copied" was unreadable | Hit-test + screenshot | Toast uses the Popover API, so it sits in the top layer above dialogs |
| X-02 | UX | **High** | **Raw validator messages** reached users, e.g. "Too big: expected number to be <=365" and "Too small: expected string to have >=20 characters" | UAT-19, UAT-21 | Global friendly message map (`src/lib/zod-messages.js`), e.g. "Renewal lead time must be 365 days or less" |
| X-03 | UX | Medium | **Browser Back** with a dialog open changed the page underneath and left the dialog open | UAT-25 | Covered by the X-01 fix |
| X-04 | UX | Medium | Opening a reset link **without a token** only failed after the user typed a password | UAT-19 | Guidance shown immediately, submit disabled, link to request a new one |
| A-03 | UA | Medium | **Focus was lost to `<body>`** after saving, renewing or deleting, and after signing in | Keyboard audit | Focus returns to the same control on the re-rendered card (or the nearest sensible one); after sign-in it moves to `<main>` |
| A-04 | UA | Medium | The **skip link** stayed 1×1 px when focused, so it was invisible | Keyboard audit | Visible, styled skip link on focus |
| A-05 | UA | Medium | The account menu used `role="menu"`, which promises arrow-key navigation it didn't implement | Keyboard audit: ArrowDown did nothing | Converted to a disclosure pattern (button + `aria-expanded`), which matches its behaviour |
| A-06 | UA | Medium | The **Import JSON** control showed no focus indicator | Keyboard audit | Focus ring drawn on the wrapping button (`:has(input:focus-visible)`) |
| U-03 | UI | Medium | At 768 px the filter tabs and the category select were **clipped** ("All typ") | Screenshot | Toolbar stacks until 1024 px; tabs wrap on phones; selects don't shrink |
| U-04 | UI | Medium | At 320 px the brand name **collided** with the theme button | Screenshot | Brand text visually hidden below 380 px (still announced) |
| U-05 | UI/UX | Medium | Non-destructive admin actions (e.g. **Send password reset**) used a red trash icon and red button | Screenshot | Confirm dialog has tones (danger / warning / primary) with matching icons; destructive dialogs start focus on **Cancel** |
| U-06 | UI | Medium | Delete account and "Generate new calendar link" used the browser's **unstyled `window.confirm`** | UAT-28 | Replaced with the app's confirm dialog |
| X-05 | UX/UA | Medium | The **Undo** toast vanished after 6 s and couldn't be paused (WCAG 2.2.1) | Code review | 10 s for actionable toasts; pauses while hovered or focused |
| E-01 | EX | Medium | **No HTTP access logs**, so a failed request left no trace for operators | Log inspection | Structured access log for `/api` and `/cal`: request ID (also returned as `X-Request-Id`), method, full path, status, duration, user ID, IP. Never logs bodies or queries; calendar tokens are redacted |
| U-07 | UI | Low | **Print/PDF** of the report had a large blank area above it | Print-media screenshot | Dialog margins reset in print CSS |
| A-07 | UA | Low | Heading levels skipped (h1 → h3); the brand link's `aria-label` didn't match its visible text (WCAG 2.5.3) | axe `heading-order`, `label-content-name-mismatch` | Card and empty-state titles are h2; brand uses its visible text |
| A-08 | UA | Low | The reminder checkbox shrank to 13 px on phones | Target measurement | Fixed at 20 px; the whole label is clickable |
| U-08 | UI | Low | The "Synced" dot stayed green when showing an offline copy | Code review | Turns amber and stops pulsing when offline |
| E-02 | EX | Low | The manifest locked installs to portrait (`portrait-primary`), awkward on tablets | Manifest review | `orientation: any` |

### Verified working (no change needed)

- **Core journeys:** sign-up → quick-start → add, edit, renew (with history), delete + undo, all five filters, the report (copy, CSV, ICS), threshold changes reclassifying items live, the calendar subscription link, JSON export/import with de-duplication, change password, forgot/reset password, theme persistence, delete account.
- **Edge cases:**
  - 29 Feb + 1 year → 28 Feb.
  - Double-clicking Save creates one item.
  - Long unbroken titles and emoji don't overflow.
  - "Expired N days ago" sorts first.
  - Out-of-band logout without a CSRF token is rejected (403).
- **Keyboard:** native `<dialog>` restores focus on Escape; the `n` / `/` shortcuts work; the menu closes with Escape and returns focus.
- **PWA:** Chrome reports zero installability or manifest errors; offline read-only mode works.
- **Admin:** unlock, send reset (link mode without SMTP), disable, audit entries; normal users are redirected away from `#/admin`.

### Open recommendations (not fixed: product decisions or larger changes)

| ID | Area | Sev. | Recommendation | Why |
|---|---|---|---|---|
| R-01 | EX | High | **2FA / passkeys for admin accounts** (WebAuthn) | An admin can trigger account takeovers via reset links; a password alone is a thin control for that power |
| R-02 | UA | Medium | **Test with real screen readers** (NVDA + Firefox, VoiceOver iOS/macOS) and on real iOS Safari | Automated tools catch roughly 30–50% of accessibility issues; Safari differs on `<dialog>`, popovers and date inputs |
| R-03 | UX | Medium | **Keep the draft when a session expires mid-edit** (stash the form in `sessionStorage`, restore after sign-in) | Users currently retype the item (UAT-26 note) |
| R-04 | UX | Medium | **Undo should restore the original item** (soft-delete with a short TTL) instead of re-creating it | Undo currently loses renewal history and the item ID |
| R-05 | UX | Medium | **Email verification at sign-up** | Without it, reminders can go to mistyped addresses; also slightly reduces squatting on someone else's email |
| R-06 | EX | Medium | Admin console: **filterable, paginated audit log**, **CSV export of users**, and an **email to the user when their account is disabled or reset by an admin** | Operator efficiency; transparency for affected users |
| R-07 | UX | Low | Disable the Add/Edit/Renew controls (not just show a toast) while **offline** | Clearer affordance |
| R-08 | UI | Low | Add **manifest `screenshots`** (narrow + wide) | Chrome and Android show a richer install sheet with them |
| R-09 | UX | Low | `/api/auth/me` returns **401 for anonymous visitors**, which logs a red console error on every first visit; consider `200 { user: null }` | Console noise only; behaviour is correct |
| R-10 | UA | Low | In the report table, add a visually hidden caption and announce the sort order | Screen-reader context for the table |

## How to reproduce

The audit scripts (Playwright and axe-core) run against a local server with the demo and admin seeds:

```bash
npm run seed:demo && npm run admin:seed -- --email admin@vaultexpiry.local
```

*(Superseded in round 2: the key checks now live in the committed end-to-end suite, `npm run test:e2e`, which runs in CI.)*
