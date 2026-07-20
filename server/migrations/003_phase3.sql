-- Phase 3 + roster protection + photos
-- manual_fields: JSON array of person columns the admin has edited by hand;
-- roster imports never overwrite these fields on this person.
ALTER TABLE person ADD COLUMN manual_fields TEXT;
-- optional photo for visual confirmation at pickup (Phase 5)
ALTER TABLE person ADD COLUMN photo_path TEXT;
