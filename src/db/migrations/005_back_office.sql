-- Back-office tooling: reasons on audit entries, support notes, invited accounts.

ALTER TABLE admin_audit ADD COLUMN reason TEXT CHECK (char_length(reason) <= 300);

ALTER TABLE admin_audit DROP CONSTRAINT admin_audit_action_check;
ALTER TABLE admin_audit ADD CONSTRAINT admin_audit_action_check CHECK (action IN
  ('password_reset_email', 'password_reset_link', 'unlock', 'revoke_sessions',
   'disable', 'enable', 'delete_user', 'invite_email', 'invite_link'));

-- Per-user activity view in the admin console.
CREATE INDEX admin_audit_target_idx ON admin_audit (target_user_id, created_at DESC);

-- Internal support notes about an account (never shown to the user; deleted with the account).
CREATE TABLE admin_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_email  TEXT NOT NULL,
  body         TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_notes_user_idx ON admin_notes (user_id, created_at DESC);

-- Set when an admin invites a user; the account shows as "invited" until its first sign-in.
ALTER TABLE users ADD COLUMN invited_at TIMESTAMPTZ;
