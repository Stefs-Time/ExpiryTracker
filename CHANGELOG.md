# Changelog

All notable changes, newest first. Dates are release dates on the development branch.

## Unreleased

### Added
- **Back-office tools in the admin console:**
  - User detail panel with labelled actions, per-account activity and internal support notes.
  - **Invite user** (the user sets their own password; works with sign-up closed).
  - Clickable status tiles, sortable columns, bookmarkable filters and a `/` search shortcut.
  - Audit log search, action filter, paging and optional **reasons** on disable/delete.
  - CSV export of users and of the audit log.
  - **System status** panel with configuration warnings.
  - Email notifications to users when an admin disables, re-enables or deletes their account.

### Changed
- **Repository audit and tidy-up:**
  - Added ESLint (flat config) to CI.
  - Removed `try/catch` boilerplate from routes, relying on Express 5's built-in async error handling.
  - Moved all request schemas into `src/lib/schemas.js`.
  - The plain-text report now has one implementation, shared by server and browser.
  - Removed unused exports (`requireAuth`, `badRequest`, `adminCount`, `dashboardState`).
- **Documentation restructured:** focused guides in `docs/` (configuration, deployment, admin, photos, testing), plus `CONTRIBUTING.md`, `SECURITY.md` and this changelog. Fixed drift in the project-structure tree and the architecture notes.

### Fixed
- The migration runner now keeps the original database error as the `cause`.
- Password reset no longer looks up the user twice.

## 2026-11-12 — Audit round 2

### Added
- **Soft delete:** Undo restores the original item with its photos and renewal history (`POST /api/items/:id/restore`, 60-minute window). A maintenance job purges deleted items afterwards, and stale reset tokens too.
- Unsaved item forms survive a session expiry (a Restore prompt after signing in again).
- A committed end-to-end suite (`npm run test:e2e`: Playwright + axe-core) and a coverage gate in CI.

### Fixed
- Undo after deleting an item lost its photos and history.
- At the 4-photo limit, the upload error was hidden by the success message.
- A scan that found no expiry date kept the placeholder date.
- `NODE_ENV` now defaults to `production` on Railway (secure cookies, no email bodies in logs).

## 2026-11-12 — Document photos & AI scanning

### Added
- **"Scan or add a photo":** Groq vision model pre-fills the item form. Consent first, output validated, numbers masked.
- **Encrypted digital copies** of documents (AES-256-GCM, owner-only, EXIF stripped), with a photo viewer and settings.

## 2026-11-12 — Admin password minimum

### Changed
- `ADMIN_PASSWORD` / `admin:seed` accept 5+ characters (previously 12+), with a warning below 12.

## 2026-11-12 — Audit round 1 (UAT, accessibility, UI, UX)

### Fixed
- **Accessibility:** WCAG AA colour contrast in both themes; mobile header buttons without accessible names; focus lost after saving; invisible skip link; ARIA menu misuse.
- **Layout:** card overflow at 320 px; clipped toolbar at tablet widths; print layout.
- **Dialogs and messages:** stale dialogs left open after session expiry or the Back button; toasts hidden behind dialogs; raw validation messages.

### Added
- HTTP access log with `X-Request-Id`.

## 2026-11-12 — Platform admin

### Added
- Admin console: user list and stats; reset, unlock, sign out everywhere, disable/enable and delete; audit log.
- `npm run admin:seed` and the `ADMIN_*` bootstrap variables.
- Railway variable reference.

## 2026-11-12 — First release

### Added
- Expiry tracker: accounts, PostgreSQL, PWA, light/dark themes, renewals with history.
- Reminders by email, calendar feed and `.ics` download.
- Status report with CSV export, JSON export/import.
