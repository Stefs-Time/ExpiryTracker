# Platform admin

A platform admin manages **accounts**, not vault contents. The console is at `#/admin` (linked from the account menu for admins).

| Admins can | Admins cannot |
|---|---|
| List, search, sort and export every user: name, email, role, status (active / locked / invited / disabled), item and photo **counts**, last sign-in, active sessions, join date | See any item's title, reference, note, date or photo |
| See platform stats (users, active users, new sign-ups, total items, reminders sent) | Sign in as a user, or see password hashes or calendar tokens |
| **Send a password reset.** With SMTP, the link goes to the user's inbox and the admin never sees it. Without SMTP, the admin gets a one-time, 60-minute link to pass on through a trusted channel | Set a user's password directly |
| **Unlock** an account locked after failed sign-ins | Disable, delete or demote **themselves** |
| **Sign out everywhere** (revokes all of a user's sessions) | Delete another **admin** (demote them first, with the CLI) |
| **Disable / enable** an account: blocks sign-in, sessions, reminders, the calendar feed and password resets, but keeps the data | Change anyone's role from the web UI |
| **Delete** an account (the admin must type the user's email to confirm) | |
| **Invite** a user, and keep internal **support notes** on an account | Read or change a user's settings |

Every action is written to an append-only `admin_audit` table: who, what, target email, an optional reason, IP and time. Entries survive deletion of the target account.

## Working in the console

**Finding accounts**
- The four tiles (**All users**, **Locked out**, **Pending invites**, **Disabled**) are filters: select one to see just those accounts.
- Search by name or email (press `/` to jump to the search box), filter by status and role, and sort by clicking the **User**, **Last sign-in** or **Joined** headers.
- Filters live in the address bar (for example `#/admin?status=locked`), so you can bookmark a view or send it to a colleague.
- **Export CSV** downloads the accounts matching the current filters (up to 5,000 rows).

**Managing an account**
- Select a user's name, or **Manage**, to open the detail panel: status, join and sign-in dates, active sessions, item and photo *counts*, reminder setting and timezone, with every action as a labelled button.
- Locked, disabled and invited accounts also show a one-click shortcut in the list (**Unlock**, **Enable**, **Resend invite**).
- **Disable** and **Delete** accept an optional internal **reason**, which is saved in the audit log and never sent to the user.
- When email is configured, the user is told by email when their account is disabled, re-enabled or deleted.

**Support notes**
- Each account has internal notes for the support team ("Phoned on 14 Nov…"). They show who wrote them and when.
- The user never sees them, and they're deleted with the account. Don't record passwords or document numbers in notes.

**Inviting users**
- **Invite user** creates an account from a name and email. The user chooses their own password through a link valid for 72 hours.
- With email configured, the link goes to their inbox and you never see it. Without it, you get a one-time link to pass on.
- The account shows as **Invited** until their first sign-in. **Resend invite** issues a fresh link (valid for 60 minutes).
- Invites work even when public sign-up is closed (`SIGNUP_ENABLED=false`), which makes an invite-only setup possible.

**Audit log**
- Search by user, admin or reason, filter by action, page through the history, and export the filtered log to CSV.
- Select a user in the log to open their detail panel.

**System status**
- Shows whether the database, email, reminder emails, the clean-up job, public sign-up, photo storage and AI scanning are working or switched off, with warnings for anything that needs attention (for example "SMTP is not configured").
- It shows flags and counts only, never secrets. Job times are for the server instance that answered the request.

## Creating admins

Promotion is deliberately **CLI-only**, so a compromised admin session can't create more admins.

```bash
npm run admin:seed -- --email you@example.com --name "Your Name"   # create (prompts for a password) or promote
```

```bash
npm run admin:seed -- --email you@example.com --reset-password     # set a new password and sign out its sessions
```

```bash
npm run admin:seed -- --email old-admin@example.com --demote       # refuses to remove the last active admin
```

- **Without a terminal (CI, `railway run`):** set `ADMIN_PASSWORD` in the environment instead of typing it.
- **Password length:** admin passwords must be 5–128 characters. Anything under 12 prints a warning.
- **Promotion** keeps the account's existing password; only `--reset-password` changes it.

### On Railway

There are two options:

1. **Bootstrap variables** (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, see [CONFIGURATION.md](CONFIGURATION.md)). On boot, the app creates the admin if no account with that email exists. It **never promotes an existing account**: with public sign-up, anyone could register your admin email before your first deploy. If the email is already registered, the bootstrap logs a warning and does nothing; check the account is yours, then promote it with the CLI.
2. **The [Railway CLI](https://docs.railway.com/guides/cli):** `railway run npm run admin:seed -- --email …`. This runs on *your* machine with the service's variables, so it needs a database URL reachable from outside Railway (the Postgres public URL, with `DATABASE_SSL=true`). If you'd rather not expose the database, use option 1.

## Security notes

- The role is read from the database on every request, so demotion and disabling take effect immediately.
- A reset link shown to an admin (no-SMTP mode) is a takeover capability, which is why it's audited as `password_reset_link`. Configure SMTP in production so admins never see links.
- Admin accounts should be the first to get 2FA/passkeys when that's added (see the roadmap in the README).
