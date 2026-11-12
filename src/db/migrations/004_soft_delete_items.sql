-- Soft delete for items so "Undo" restores the original item, its photos and renewal
-- history. A maintenance job purges soft-deleted items after the undo window.
ALTER TABLE items ADD COLUMN deleted_at TIMESTAMPTZ;

-- Every user-facing query filters on live items; make the main index partial.
DROP INDEX IF EXISTS items_user_expiry_idx;
CREATE INDEX items_user_expiry_idx ON items (user_id, expiry_date) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS items_expiry_idx;
CREATE INDEX items_expiry_idx ON items (expiry_date) WHERE deleted_at IS NULL;
-- Purge job scans deleted rows by time.
CREATE INDEX items_deleted_idx ON items (deleted_at) WHERE deleted_at IS NOT NULL;
