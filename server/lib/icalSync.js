'use strict';
// Trail Life Connect iCal feed sync (Phase 2).
// All events are discrete — no RRULE handling by design (see build plan).
// Rule: an ical event that disappears from the feed is DELETED if nothing of
// record hangs off it, but KEPT and flagged (removed_from_feed=1) if anything
// does — sign-ins, texts, attendance pushes (see eventReferences below).
const ical = require('node-ical');
const { db } = require('../db');
const env = require('./env');

const iso = (d) => new Date(d).toISOString();
// node-ical returns a text property as a plain string — unless the feed put a
// parameter on it (SUMMARY;LANGUAGE=en-US:…), when it is { params, val }.
// Handing that object to SQLite throws and rolls back the whole sync.
const text = (v) => {
  const s = v && typeof v === 'object' ? v.val : v;
  return s == null || s === '' ? null : String(s);
};

// What an event that left the feed is still attached to decides its fate.
// DERIVED tables are caches rebuilt from the member portal — they go with
// the event. Every OTHER table that references event(id) is history (sign-ins,
// texts sent, attendance pushed) and keeps the event, flagged. The list of
// referencing tables is read from the schema, not written down here: a table
// added later that nobody taught this file about counts as history, so the
// worst case is a kept event — never a foreign-key error, which used to roll
// back the ENTIRE sync and silently freeze the calendar.
const DERIVED = new Set(['event_form_status']);
function eventReferences() {
  const refs = [];
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()) {
    for (const fk of db.pragma(`foreign_key_list("${name.replace(/"/g, '""')}")`)) {
      if (fk.table === 'event') refs.push({ table: name, column: fk.from });
    }
  }
  return refs;
}
const quote = (id) => `"${id.replace(/"/g, '""')}"`;

function eventStatements() {
  const refs = eventReferences();
  return {
    history: refs.filter((r) => !DERIVED.has(r.table))
      .map((r) => db.prepare(`SELECT 1 FROM ${quote(r.table)} WHERE ${quote(r.column)} = ? LIMIT 1`)),
    derived: refs.filter((r) => DERIVED.has(r.table))
      .map((r) => db.prepare(`DELETE FROM ${quote(r.table)} WHERE ${quote(r.column)} = ?`)),
  };
}

// Shared with the admin "delete event" route: true = deleted (with its derived
// rows), false = it has history and must stay.
function deleteEventUnlessHistory(id) {
  const { history, derived } = eventStatements();
  if (history.some((q) => q.get(id))) return false;
  db.transaction(() => {
    for (const del of derived) del.run(id);
    db.prepare('DELETE FROM event WHERE id = ?').run(id);
  })();
  return true;
}

function applyFeed(vevents) {
  const { history, derived } = eventStatements();
  let added = 0, updated = 0, flagged = 0, deleted = 0;
  const run = db.transaction(() => {
    const seen = new Set();
    const upd = db.prepare(
      `UPDATE event SET title = ?, location = ?, description = ?, end_at = ?, all_day = ?,
                        removed_from_feed = 0
        WHERE id = ?`);
    for (const e of vevents) {
      const startAt = iso(e.start), endAt = iso(e.end);
      seen.add(`${e.uid}|${startAt}`);
      const allDay = e.datetype === 'date' ? 1 : 0;
      const ex = db.prepare('SELECT * FROM event WHERE ical_uid = ? AND start_at = ?').get(e.uid, startAt);
      const title = text(e.summary) || '(untitled)';
      const location = text(e.location), description = text(e.description);
      if (!ex) {
        // new feed events start on the global adult-tracking default; the
        // feed never touches track_adults again (app-owned, like the forms)
        db.prepare(
          `INSERT INTO event (source, ical_uid, title, location, description, start_at, end_at, all_day,
                              track_adults, track_adults_source)
           VALUES ('ical', ?, ?, ?, ?, ?, ?, ?, ?, 'auto')`
        ).run(e.uid, title, location, description, startAt, endAt, allDay,
              require('./adultTracking').getSettings().default);
        added++;
      } else {
        const changed = ex.title !== title || ex.location !== location ||
          ex.description !== description || ex.end_at !== endAt ||
          ex.all_day !== allDay || ex.removed_from_feed !== 0;
        if (changed) { upd.run(title, location, description, endAt, allDay, ex.id); updated++; }
      }
    }
    for (const row of db.prepare(`SELECT * FROM event WHERE source = 'ical'`).all()) {
      if (seen.has(`${row.ical_uid}|${row.start_at}`)) continue;
      const hasHistory = history.some((q) => q.get(row.id));
      if (hasHistory) {
        if (!row.removed_from_feed) { db.prepare('UPDATE event SET removed_from_feed = 1 WHERE id = ?').run(row.id); flagged++; }
      } else {
        for (const del of derived) del.run(row.id);
        db.prepare('DELETE FROM event WHERE id = ?').run(row.id);
        deleted++;
      }
    }
  });
  run();
  return { added, updated, flagged, deleted, feed_events: vevents.length };
}

async function syncIcal(url = env.ICAL_URL) {
  if (!url) throw new Error('ICAL_URL is not configured — set it in .env.');
  const data = await ical.async.fromURL(url);
  const vevents = Object.values(data).filter(
    (e) => e.type === 'VEVENT' && e.uid && e.start && e.end
  );
  const result = applyFeed(vevents);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('last_ical_sync', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify({ at: new Date().toISOString(), ...result }));
  require('./webhook').emitIcalSynced(result); // integration webhook — counts only; off by default
  return result;
}

function scheduleNightly() {
  if (!env.ICAL_URL) return null;
  const timer = setInterval(() => {
    syncIcal().catch((e) => console.error('ical sync failed:', e.message));
  }, 24 * 60 * 60 * 1000);
  timer.unref();
  // one sync shortly after boot, once the server is up
  setTimeout(() => syncIcal().catch((e) => console.error('ical sync failed:', e.message)), 15_000).unref();
  return timer;
}

module.exports = { syncIcal, applyFeed, scheduleNightly, deleteEventUnlessHistory };
