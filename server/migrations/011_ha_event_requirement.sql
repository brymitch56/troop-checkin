-- Per-event High Adventure medical-form requirement. App-owned: TLC's iCal
-- feed has no structured form-requirement field (verified against the live
-- feed 2026-08), so this is set only in the admin event editor, and the iCal
-- sync's fixed UPDATE column list must never include it. When set, the kiosk
-- shows a calm informational badge (never a block) at sign-in for anyone
-- whose High Risk form is missing or outside the validity window.
ALTER TABLE event ADD COLUMN requires_high_adventure_form INTEGER NOT NULL DEFAULT 0;
