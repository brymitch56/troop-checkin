-- Two small admin controls.
--
-- event.auto_select — when two events overlap, the kiosk suggests whichever
-- one's sign-in/sign-out moment is nearest. 0 keeps an event out of that
-- suggestion: it is still listed under "Now" in the event picker, but staff
-- must pick it by hand. 1 (the default) is the behaviour before this column.
ALTER TABLE event ADD COLUMN auto_select INTEGER NOT NULL DEFAULT 1;

-- tlc_attendance_push dismissal — a failed push that will never succeed
-- (a non-member who is not on the portal at all) can be dismissed by an
-- admin. The row keeps status 'failed' (the status CHECK predates this) and
-- its detail; dismissed_at takes it out of the failed count and out of
-- "Retry failed". Who and why are kept for the audit trail.
ALTER TABLE tlc_attendance_push ADD COLUMN dismissed_at TEXT;
ALTER TABLE tlc_attendance_push ADD COLUMN dismissed_by INTEGER REFERENCES staff(id);
ALTER TABLE tlc_attendance_push ADD COLUMN dismiss_note TEXT;
