-- TLC attendance write-back (docs/12-attendance-writeback.md).
-- person.tlc_user_id: cached TLC user hashid, learned by matching names on
--   the /calendar/attendance-user-list fragment (the roster export has no
--   hashids). Cleared only by hand — hashids are stable per member.
-- event.tlc_event_id: cached TLC event hashid. For ical events it is parsed
--   from the middle segment of the feed UID (<16>-<12 hashid>-<15>);
--   manual events stay NULL until linked by hand in the event editor.
-- event.tlc_push: per-event override — NULL follow the global setting,
--   0 never push, 1 always push (when a TLC event id is resolvable).
ALTER TABLE person ADD COLUMN tlc_user_id TEXT;
ALTER TABLE event ADD COLUMN tlc_event_id TEXT;
ALTER TABLE event ADD COLUMN tlc_push INTEGER;

-- One row per (event, person) that ever needs marking attended on TLC.
-- value is always 1 — the app NEVER un-marks attendance on TLC; undo is a
-- human action on the TLC site. use_lesson_plans is frozen at enqueue time
-- so the admin can see exactly what a push did/will do.
CREATE TABLE tlc_attendance_push (
  id INTEGER PRIMARY KEY,
  event_id  INTEGER NOT NULL REFERENCES event(id),
  person_id INTEGER NOT NULL REFERENCES person(id),
  tlc_event_id TEXT NOT NULL,
  tlc_user_id  TEXT,
  value INTEGER NOT NULL DEFAULT 1,
  use_lesson_plans INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed')),
  detail TEXT,               -- 'already marked on TLC', error message, …
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  UNIQUE (event_id, person_id)
);
CREATE INDEX idx_tlc_push_status ON tlc_attendance_push(status);
