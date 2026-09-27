-- Door-staff visibility for guardian text replies.
--
-- Replies used to land only in Admin -> Messages, where nobody at the door
-- knows to look. Kiosks now show a banner for unseen replies; whoever taps
-- "Got it" clears it for every station. seen_at/seen_by record that.
ALTER TABLE sms_message ADD COLUMN seen_at TEXT;
ALTER TABLE sms_message ADD COLUMN seen_by INTEGER REFERENCES staff(id);

-- Everything already received predates the banner — don't light up every
-- kiosk with old history on the first boot after this migration.
UPDATE sms_message SET seen_at = datetime('now') WHERE direction = 'in';
