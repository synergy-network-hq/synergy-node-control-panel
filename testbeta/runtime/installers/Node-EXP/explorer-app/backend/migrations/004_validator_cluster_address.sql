BEGIN;

ALTER TABLE validators_current
  ADD COLUMN IF NOT EXISTS cluster_address TEXT;

COMMIT;
