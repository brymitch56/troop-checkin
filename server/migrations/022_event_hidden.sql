-- Hidden events stay in the database (and keep syncing from the feed) but are
-- left out of the kiosk, the offline snapshot, on-site moves and the
-- integration API. Admin-owned: the calendar sync never changes it after
-- insert. Events first seen in an ADDITIONAL feed (area, region, national —
-- anything after the first ICAL_URL) start hidden, since a unit attends only a
-- few of them; the admin shows the ones the unit is going to.
ALTER TABLE event ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
