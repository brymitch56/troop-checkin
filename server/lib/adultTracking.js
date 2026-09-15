'use strict';
// Global default for adult attendance tracking.
//
// meta key 'adult_tracking' — {default: 0|1}. Default OFF, which is exactly
// the pre-existing behaviour (every event youth-only unless an admin ticks
// "Track adult attendance"). Same manual-wins pattern as the permission-form
// Warn/Block default (lib/permissionSync.js, migration 013):
//   - new events (iCal sync, kiosk/admin create) start on the global value;
//   - changing the global value bulk-applies to current + future events that
//     still follow it (track_adults_source NULL/'auto');
//   - an event an admin set by hand ('manual') is never touched, and past
//     events are never rewritten (their attendance is history).
const { db } = require('../db');

const KEY = 'adult_tracking';

function getSettings() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
  let v = {};
  if (row) { try { v = JSON.parse(row.value); } catch { /* ignore */ } }
  return { default: v.default ? 1 : 0 };
}

function saveSettings(b) {
  const cur = getSettings();
  const v = { default: (b && 'default' in b) ? (b.default ? 1 : 0) : cur.default };
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(KEY, JSON.stringify(v));
  return v;
}

// Bulk-apply the global value to events that have not finished yet, sparing
// every hand-set choice. Returns the number of events whose value changed.
function applyDefault(val) {
  const r = db.prepare(
    `UPDATE event SET track_adults = ?, track_adults_source = 'auto'
      WHERE datetime(end_at) >= datetime('now')
        AND (track_adults_source IS NULL OR track_adults_source != 'manual')
        AND (track_adults != ? OR track_adults_source IS NULL)`
  ).run(val ? 1 : 0, val ? 1 : 0);
  // the count reported to the admin is events whose tracking actually flipped;
  // NULL->'auto' stamping of already-matching rows rides along silently
  return r.changes;
}

// Value + source for a newly created event. No explicit choice → follow the
// global default. An explicit choice that matches the default still follows
// it (the kiosk checkbox starts on the default, so leaving it alone must not
// pin the event); a choice that differs is hand-set.
function forNewEvent(explicit) {
  const def = getSettings().default;
  if (explicit === undefined || explicit === null) return { track_adults: def, source: 'auto' };
  const v = explicit ? 1 : 0;
  return { track_adults: v, source: v === def ? 'auto' : 'manual' };
}

module.exports = { getSettings, saveSettings, applyDefault, forNewEvent, KEY };
