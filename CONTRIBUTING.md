# Contributing

## Workflow

1. Branch from the default branch, and keep each change focused.
2. Run `npm run check` (lint + tests with coverage) and, for UI changes, `npm run test:e2e`.
3. Update the docs in the same change when behaviour, configuration or the API changes (see the checklist below).
4. Write clear commit messages: a short imperative summary line, then the *why*.

## Conventions

**Code**
- **Node 22, ES modules, `async`/`await`.** The server has no build step, and neither does the browser code.
- **Layers:** `routes/` parse and validate input (zod schemas in `src/lib/schemas.js`) and shape responses. `services/` hold business logic and SQL. `lib/` holds framework-free helpers.
- **Errors:** throw `AppError` (or the helpers in `src/lib/errors.js`) from anywhere. Express 5 forwards rejected promises from async handlers to the error middleware, so routes don't need `try/catch`.
- **API responses:** `{ success: true, data, meta? }` or `{ success: false, error: { code, message, details? } }`. Document new endpoints in `docs/API.md`.
- **SQL:** always parameterised. User-facing item queries must include `deleted_at IS NULL` (soft delete).
- **Shared rules:** expiry/status logic lives only in `public/js/shared/expiry.js`, which both server and browser import. Don't duplicate it.

**Frontend**
- **No inline scripts or styles:** the CSP forbids them. Set dynamic styles through the CSSOM (`el.style.x = …`).
- **Escaping:** every user-provided string rendered through `innerHTML` must pass through `esc()` (`public/js/ui.js`).
- **Accessibility:** native `<dialog>`, real buttons, labels for every input, visible focus. The end-to-end axe scans must stay at zero violations.
- **Tokens:** colours come from CSS custom properties (`public/css/app.css`). Check contrast in both themes.

**Assets and schema**
- **Service worker:** bump `VERSION` in `public/sw.js` whenever a shell file (HTML, CSS, JS, icons) changes.
- **Icons:** add the Lucide name to `ICONS` in `scripts/build-icons.js`, then run `npm run icons`.
- **Migrations:** add a new file `src/db/migrations/NNN_description.sql`. Never edit one that's been applied anywhere. Mirror validation rules as `CHECK` constraints where practical.

## Documentation checklist

| If you change… | Update |
|---|---|
| An environment variable | `src/config.js`, `.env.example`, `docs/CONFIGURATION.md` |
| An endpoint or response shape | `docs/API.md` (+ tests) |
| A security control or data model | `docs/ARCHITECTURE.md` |
| Admin behaviour | `docs/ADMIN.md` |
| Photos or AI scanning | `docs/PHOTOS.md` |
| Commands or setup | `README.md`, `docs/TESTING.md` |
| Anything user-visible | `CHANGELOG.md` |

## Dependencies

Pin exact versions, prefer mature releases (at least two weeks old), keep production dependencies minimal, and check `npm audit` before adding one.
