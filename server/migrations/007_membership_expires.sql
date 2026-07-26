-- Membership-expiration alert (feature: warn at check-in within 30 days).
-- Populated by roster imports from the TLC export's "Membership Exp." column
-- (normalized to ISO YYYY-MM-DD when the cell format is recognizable, raw
-- string otherwise — compare-time code parses defensively). Admin-editable;
-- hand edits lock the field against imports like every import-managed field.
ALTER TABLE person ADD COLUMN membership_expires TEXT;
