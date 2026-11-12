-- Platform administration: roles, account disabling, last-login tracking, admin audit trail.

ALTER TABLE users
  ADD COLUMN role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  ADD COLUMN disabled_at   TIMESTAMPTZ,
  ADD COLUMN last_login_at TIMESTAMPTZ;

-- Admin user list is ordered by signup date and filtered by role/status.
CREATE INDEX users_created_idx ON users (created_at DESC);

-- Append-only record of every admin action. target_email is kept so the trail
-- survives deletion of the target account (target_user_id becomes NULL).
CREATE TABLE admin_audit (
  id              BIGSERIAL PRIMARY KEY,
  admin_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_email     TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN
                    ('password_reset_email', 'password_reset_link', 'unlock', 'revoke_sessions',
                     'disable', 'enable', 'delete_user')),
  target_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  target_email    TEXT NOT NULL,
  ip              TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit (created_at DESC);
