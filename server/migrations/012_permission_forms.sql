-- Per-event parent permission forms (risk-assessment events: campouts,
-- range days, etc). Requirement + per-youth signed status come from TLC
-- (lib/permissionSync.js); TLC's iCal feed carries nothing about forms.
--
-- requires_permission_form: the event needs a parent-signed permission form.
--   Set by the nightly grid sweep (source 'auto') — re-checked continuously
--   because the troop often enables TLC's activity/forms setting well after
--   creating the event. A hand set/clear in admin flips source to 'manual',
--   which the sweep never overrides.
-- permission_block: per-event soft-block — when set, unsigned youth cannot
--   be signed in without a recorded staff override or a fresh re-check.
--   Default 0: prominent banner only.
-- tlc_et_slug: TLC's export slug for the event (from the view-events grid;
--   distinct from tlc_event_id's hashid and not derivable from it).
ALTER TABLE event ADD COLUMN requires_permission_form INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event ADD COLUMN permission_form_source TEXT
  CHECK (permission_form_source IN ('auto','manual'));
ALTER TABLE event ADD COLUMN permission_block INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event ADD COLUMN tlc_et_slug TEXT;

-- Per-event, per-YOUTH signed status snapshot (youth only by decision —
-- parents sign for youth; adult rows in the TLC export are ignored).
-- fetched_at is surfaced everywhere the data is shown: parents sign at the
-- last minute, so staleness must be visible, never hidden.
CREATE TABLE event_form_status (
  event_id  INTEGER NOT NULL REFERENCES event(id),
  person_id INTEGER NOT NULL REFERENCES person(id),
  signed    INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  source    TEXT NOT NULL DEFAULT 'sync' CHECK (source IN ('sync','upload')),
  PRIMARY KEY (event_id, person_id)
);

-- Recorded staff override of a permission-form soft-block (mirrors the
-- unauthorized-signer `forced` column; reviewable in admin).
ALTER TABLE txn ADD COLUMN permission_override INTEGER NOT NULL DEFAULT 0;
