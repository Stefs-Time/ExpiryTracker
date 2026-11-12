# Deployment & operations

## Deploying to Railway

1. Create a project, add a **PostgreSQL** service, then add this repository as a service.
2. Generate a public domain under the app service's **Settings → Networking**.
3. Set the variables from [CONFIGURATION.md](CONFIGURATION.md); the starter block covers a typical setup.
4. Deploy. `railway.json` sets the start command (`npm start`), the `/healthz` health check and the restart policy. Railway detects Node from `package.json` (`engines.node`) and installs with `npm ci`.
5. On boot the app runs pending migrations, then the optional admin bootstrap. Look for `"Platform admin bootstrap" … "action":"created"` in the deploy logs.
6. Sign in as the admin, **delete `ADMIN_PASSWORD`** from the variables, and change the password in Settings.

Any host that runs Node 22 and provides PostgreSQL works the same way: set the variables, run `npm ci --omit=dev`, then `npm start`.

## Boot sequence and shutdown

`src/server.js`:
1. Validates config.
2. Runs migrations under a PostgreSQL advisory lock, so replicas can't race.
3. Bootstraps the admin.
4. Listens on `0.0.0.0:$PORT`.
5. Starts the background jobs.

On `SIGTERM` it stops accepting connections, drains, closes the database pool and exits within 10 seconds.

## Background jobs (in-process)

| Job | Interval | What it does | Multi-replica safety |
|---|---|---|---|
| Reminders (`services/reminders.js`) | hourly, first run 30 s after boot | Emails each opted-in user one digest when items enter a reminder stage. Sends only after 07:00 in the user's timezone | Advisory lock (one replica per pass); `reminder_log` makes each stage send at most once; failed sends are retried next pass |
| Maintenance (`services/maintenance.js`) | every 10 min, first run 5 s after boot | Permanently deletes items soft-deleted more than 60 minutes ago (cascading photos and history), and stale password-reset tokens | Idempotent deletes |

Reminders don't start in production without SMTP configured, or when `REMINDERS_ENABLED=false`.

## Data, backups and keys

- **Everything persistent lives in PostgreSQL,** including encrypted photos. The container filesystem is ephemeral and the app writes nothing to disk.
- **Backups:** enable Railway's Postgres backups, or schedule `pg_dump`. Photos make backups larger; past several GB, consider moving photo bytes to S3-compatible storage behind `src/services/attachments.js`.
- **`FILE_ENCRYPTION_KEY`:** store a copy **separately** from database backups (e.g. in a password manager). A backup without the key can't decrypt photos, which is the point, and a lost key means lost photos. Rotation isn't implemented yet.
- **`SESSION_SECRET`:** changing it signs everyone out. Nothing else depends on it.
- **Restore test:** periodically restore a backup into a scratch database and start the app against it with the production key. This checks the backup and confirms the key.

## Upgrades and migrations

- Migrations are forward-only SQL files in `src/db/migrations/`, numbered `NNN_description.sql`. Each runs in a transaction and is recorded in `schema_migrations`.
- Deploys apply them automatically on boot. You can also run `npm run migrate` against the target database first.
- **Rollback:** redeploy the previous build. Migrations so far only add columns, tables and indexes, so older code keeps working against a newer schema. For anything destructive, write a new forward migration rather than editing an applied one.
- **Service worker:** bump `VERSION` in `public/sw.js` with any change to shell files (HTML, CSS, JS, icons). Installed apps then show "A new version is available → Refresh".

## Logs and monitoring

Logs are structured JSON on stdout/stderr (Railway's log explorer can filter them):

| `msg` | When | Fields |
|---|---|---|
| `http` | every `/api` and `/cal` request | `reqId`, `method`, `path` (no query; calendar tokens redacted), `status`, `ms`, `userId`, `ip`. Level `warn` for 4xx, `error` for 5xx |
| `Unhandled error` | unexpected exceptions | message and stack (never sent to clients) |
| `Document scanned` | each AI scan | model, latency, token count, category, whether an expiry was found (never the image or extracted values) |
| `Reminder pass complete` / `Maintenance` | background jobs | counts |

Every API response carries an `X-Request-Id`. When a user reports an error, ask for it (or find the time) and search the logs.

- **Health check:** `GET /healthz` returns 200 `{"status":"ok"}` when the database answers, 503 otherwise.
- **Scaling notes:** sessions are in Postgres, so replicas work. Rate limits are in-memory per instance, so with N replicas the effective limits are N times higher.

## Operator checklist (production)

- [ ] `NODE_ENV=production` (automatic on Railway) and `APP_URL` set to the real HTTPS domain
- [ ] SMTP configured, and a test password reset received
- [ ] Platform admin created; `ADMIN_PASSWORD` removed; admin password changed in Settings
- [ ] Postgres backups enabled; a restore tested
- [ ] If photos are enabled: `FILE_ENCRYPTION_KEY` stored safely, separately from backups
- [ ] If AI scanning is enabled: Groq **Zero Data Retention** turned on, the consent text checked, and the model tested on real documents ([PHOTOS.md](PHOTOS.md))
- [ ] Decide whether public sign-up should stay open (`SIGNUP_ENABLED`)
