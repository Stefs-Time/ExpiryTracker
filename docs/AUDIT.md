# VaultExpiry — UAT, UA, UI, UX & EX audit

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

The scripts aren't committed: they need Chromium and `axe-core`, which aren't project dependencies. If you want this audit repeatable in CI, adopt them as a Playwright suite. That would be a worthwhile follow-up.
