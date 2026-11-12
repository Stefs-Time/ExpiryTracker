-- VaultExpiry initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() (built-in on PG13+, kept for older servers)

CREATE TABLE users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  password_hash        TEXT NOT NULL,
  display_name         TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  timezone             TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
  critical_days        INTEGER NOT NULL DEFAULT 30 CHECK (critical_days BETWEEN 1 AND 365),
  warning_days         INTEGER NOT NULL DEFAULT 90 CHECK (warning_days BETWEEN 2 AND 730),
  email_reminders      BOOLEAN NOT NULL DEFAULT TRUE,
  calendar_token_hash  TEXT UNIQUE,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  password_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_thresholds_ordered CHECK (warning_days > critical_days)
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  category      TEXT NOT NULL CHECK (category IN
                  ('Vehicle','License','Firearm','Banking','Identity','Insurance','Medical','Subscription','Other')),
  ref           TEXT NOT NULL DEFAULT '' CHECK (char_length(ref) <= 40),
  expiry_date   DATE NOT NULL,
  cycle_months  INTEGER NOT NULL DEFAULT 60 CHECK (cycle_months BETWEEN 1 AND 240),
  lead_days     INTEGER NOT NULL DEFAULT 30 CHECK (lead_days BETWEEN 0 AND 365),
  note          TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Every list/report query is "this user's items ordered by expiry".
CREATE INDEX items_user_expiry_idx ON items (user_id, expiry_date);
-- Reminder job scans by expiry date across users.
CREATE INDEX items_expiry_idx ON items (expiry_date);

CREATE TABLE item_renewals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id          UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  previous_expiry  DATE NOT NULL,
  new_expiry       DATE NOT NULL,
  renewed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX item_renewals_item_idx ON item_renewals (item_id, renewed_at DESC);

CREATE TABLE password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- One row per reminder email stage actually sent, so reminders are never duplicated.
CREATE TABLE reminder_log (
  item_id      UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  expiry_date  DATE NOT NULL,
  stage        TEXT NOT NULL CHECK (stage IN ('lead','warning','critical','week','expired')),
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, expiry_date, stage)
);

-- Session store used by connect-pg-simple (its documented schema).
CREATE TABLE "session" (
  "sid"    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX "IDX_session_expire" ON "session" ("expire");
