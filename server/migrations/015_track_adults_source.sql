-- Global default for adult attendance tracking (setting lives in meta
-- 'adult_tracking'.default). Mirrors permission_block_source (013):
-- 'manual' = an admin chose this event's adult tracking by hand and the
-- global bulk-apply must never change it; 'auto' (or NULL) = follows the
-- global default.
ALTER TABLE event ADD COLUMN track_adults_source TEXT
  CHECK (track_adults_source IN ('auto','manual'));

-- Backfill: every event that tracks adults today was switched on by hand
-- (the global default did not exist yet, and it starts OFF), so preserve
-- those choices through the first bulk-apply. Untracked events stay NULL =
-- follow global.
UPDATE event SET track_adults_source = 'manual' WHERE track_adults = 1;
