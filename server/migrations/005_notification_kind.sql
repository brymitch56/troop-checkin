-- Distinguish lingering-pickup alerts (deduped per youth/guardian/event,
-- Y-closeable) from custom broadcasts (ETA updates etc. — repeatable, never
-- close a sign-in).
ALTER TABLE notification ADD COLUMN kind TEXT NOT NULL DEFAULT 'lingering'
  CHECK (kind IN ('lingering', 'custom'));
