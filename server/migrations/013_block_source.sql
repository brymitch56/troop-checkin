-- Global Warn/Block default for permission-form events (setting lives in
-- meta 'permission_forms'.block_default). This column mirrors the
-- permission_form_source pattern: 'manual' = the admin chose this event's
-- Warn/Block by hand in the editor and the global bulk-apply / sweep must
-- never change it; 'auto' (or NULL) = follows the global default.
ALTER TABLE event ADD COLUMN permission_block_source TEXT
  CHECK (permission_block_source IN ('auto','manual'));

-- Backfill: every event that is Block today was hand-set through the
-- editor (the global default did not exist yet), so preserve those choices
-- through the first bulk-apply. Warn events stay NULL = follow global.
UPDATE event SET permission_block_source = 'manual' WHERE permission_block = 1;
