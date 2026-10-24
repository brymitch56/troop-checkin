-- Attendees whose level is not in the event's activity plan (a Navigator at a
-- Woodlands-only meeting): 'hold' parks their push like any other uncovered
-- attendee; 'push' marks attendance at once, attendance only. NULL follows the
-- global setting (tlc_attendance.uncovered_levels, default 'hold').
ALTER TABLE event ADD COLUMN tlc_uncovered TEXT CHECK (tlc_uncovered IN ('hold', 'push'));
