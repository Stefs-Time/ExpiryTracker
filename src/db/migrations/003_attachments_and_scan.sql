-- Encrypted document photos ("digital copies") and AI-scan consent.

CREATE TABLE item_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT 'front' CHECK (label IN ('front', 'back', 'other')),
  content_type  TEXT NOT NULL CHECK (content_type = 'image/jpeg'),
  byte_size     INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 4194304),
  width         INTEGER CHECK (width > 0),
  height        INTEGER CHECK (height > 0),
  sha256        TEXT NOT NULL,             -- of the plaintext, for integrity checks
  key_version   SMALLINT NOT NULL DEFAULT 1, -- supports future key rotation
  iv            BYTEA NOT NULL,             -- AES-256-GCM nonce (12 bytes)
  auth_tag      BYTEA NOT NULL,             -- AES-256-GCM tag (16 bytes)
  data          BYTEA NOT NULL,             -- ciphertext
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX item_attachments_item_idx ON item_attachments (item_id, created_at);
CREATE INDEX item_attachments_user_idx ON item_attachments (user_id);

-- When the user agreed to send photos to the AI provider (POPIA: informed consent
-- for processing by, and transfer to, a third-party operator).
ALTER TABLE users ADD COLUMN ai_scan_consent_at TIMESTAMPTZ;
