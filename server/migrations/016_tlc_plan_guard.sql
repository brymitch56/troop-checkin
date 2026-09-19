-- Activity-plan guard for the TLC attendance write-back
-- (docs/12-attendance-writeback.md, "Activity-plan guard").
--
-- Marking someone Attended on TLC is the moment advancement is applied, and
-- it is one-way: once TLC shows attended=1 the app never re-posts, so a
-- mis-scoped activity plan silently costs that youth the credit forever.
-- The guard reads the event's plans first and HOLDS a push whose advancement
-- would not land, leaving the row 'pending' so the next sweep re-evaluates it
-- and sends it the moment the plan is corrected on TLC.
--
-- hold_reason: why the row is parked (NULL = not held). Kept on the pending
--   row rather than a new status value so the sweep retries it for free.
-- hold_since: when it was first parked — drives the auto-release window.
ALTER TABLE tlc_attendance_push ADD COLUMN hold_reason TEXT;
ALTER TABLE tlc_attendance_push ADD COLUMN hold_since TEXT;

-- A held row is released after the configured window so the ATTENDANCE
-- record is never silently lost — but the advancement that was given up is
-- recorded here, permanently and loudly, until a human confirms they fixed
-- it on TLC. Dismissal is deliberately two-step: 'verify' re-reads TLC and
-- checks the youth now holds the plan's items, and only a confirmed verify
-- (or an explicit forced acknowledgement carrying a note) clears the row.
CREATE TABLE tlc_advancement_skipped (
  id INTEGER PRIMARY KEY,
  -- the push row is only a breadcrumb: pruning the queue must never take the
  -- record of forgone advancement with it
  push_id      INTEGER REFERENCES tlc_attendance_push(id) ON DELETE SET NULL,
  event_id     INTEGER NOT NULL REFERENCES event(id),
  person_id    INTEGER NOT NULL REFERENCES person(id),
  tlc_event_id TEXT NOT NULL,
  tlc_user_id  TEXT,
  reason       TEXT NOT NULL,   -- why the advancement could not land
  plan_snapshot TEXT,           -- JSON of the plans as they stood at release
  held_since   TEXT,
  released_at  TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at  TEXT,            -- last verify attempt
  verify_result TEXT CHECK (verify_result IN ('confirmed','not_found','error')),
  verify_detail TEXT,
  acknowledged_at TEXT,
  acknowledged_by INTEGER REFERENCES staff(id),
  acknowledge_note TEXT,
  UNIQUE (event_id, person_id)
);
CREATE INDEX idx_tlc_skipped_open
  ON tlc_advancement_skipped(acknowledged_at);
