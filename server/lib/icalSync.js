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
    // anything at all hanging off the event, history or cache
    attached: refs.map((r) => db.prepare(`SELECT 1 FROM ${quote(r.table)} WHERE ${quote(r.column)} = ? LIMIT 1`)),
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

// ---- which row IS this feed event? ------------------------------------------
// A portal UID is <head>-<event id>-<tail>, and the tail is a timestamp that
// CHANGES whenever someone edits the event in the portal (seen: a start time
// moved by 90 minutes). Matching on the whole UID + start therefore read every
// edit as "old event gone, new event added": the new row started from defaults
// while the form requirement, the block setting, hand-set adult tracking, the
// cached form statuses and any sign-ins stayed behind on a row now flagged
// "gone from feed" — and the permission detector, which looks events up by
// portal id, kept updating that ghost. The middle segment is the stable id
// (attendanceSync.tlcEventIdFromUid); when a UID has one, it decides identity.
// UIDs without one (manual events, foreign feeds) keep the exact-match rule.
const portalIdOf = (uid) => require('./attendanceSync').tlcEventIdFromUid(uid);
const MANUAL = ['permission_form_source', 'permission_block_source', 'track_adults_source'];

function applyFeed(vevents) {
  const { history, derived, attached } = eventStatements();
  let added = 0, updated = 0, flagged = 0, deleted = 0, merged = 0;
  const hasHistory = (row) => history.some((q) => q.get(row.id));
  // "bare" = nothing attached and nothing a person set by hand: safe to fold away
  const isBare = (row) => !attached.some((q) => q.get(row.id)) && !MANUAL.some((c) => row[c] === 'manual');
  const feedPortalIds = new Map();
  for (const e of vevents) { const p = portalIdOf(e.uid); if (p) feedPortalIds.set(p, (feedPortalIds.get(p) || 0) + 1); }
  const rowsForPortalId = (pid) => db.prepare(
    `SELECT * FROM event WHERE source = 'ical' AND (tlc_event_id = ? OR ical_uid LIKE ?) ORDER BY id`)
    .all(pid, `%-${pid}-%`).filter((r) => r.tlc_event_id === pid || portalIdOf(r.ical_uid) === pid);
  const run = db.transaction(() => {
    const seen = new Set();
    const upd = db.prepare(
      `UPDATE event SET ical_uid = ?, start_at = ?, title = ?, location = ?, description = ?,
                        end_at = ?, all_day = ?, removed_from_feed = 0
        WHERE id = ?`);
    for (const e of vevents) {
      const startAt = iso(e.start), endAt = iso(e.end);
      seen.add(`${e.uid}|${startAt}`);
      const allDay = e.datetype === 'date' ? 1 : 0;
      let ex = db.prepare('SELECT * FROM event WHERE ical_uid = ? AND start_at = ?').get(e.uid, startAt);
      const pid = portalIdOf(e.uid);
      if (pid && feedPortalIds.get(pid) === 1) {
        // every row this portal event has ever produced, the exact match included
        const rows = rowsForPortalId(pid);
        if (rows.length && !(rows.length === 1 && ex)) {
          // keep the row that carries the most: history, then attachments or
          // hand-made settings, then the exact match, then the oldest
          const score = (r) => (hasHistory(r) ? 4 : 0) + (isBare(r) ? 0 : 2) + (ex && r.id === ex.id ? 1 : 0);
          const keeper = rows.reduce((best, r) => (score(r) > score(best) ? r : best));
          for (const r of rows) {
            if (r.id === keeper.id || !isBare(r)) continue; // a second row with its own history stays, flagged below
            db.prepare('DELETE FROM event WHERE id = ?').run(r.id);
            merged++;
          }
          ex = keeper;
        }
      }
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
        const changed = ex.ical_uid !== e.uid || ex.start_at !== startAt ||
          ex.title !== title || ex.location !== location ||
          ex.description !== description || ex.end_at !== endAt ||
          ex.all_day !== allDay || ex.removed_from_feed !== 0;
        if (changed) { upd.run(e.uid, startAt, title, location, description, endAt, allDay, ex.id); updated++; }
      }
    }
    for (const row of db.prepare(`SELECT * FROM event WHERE source = 'ical'`).all()) {
      if (seen.has(`${row.ical_uid}|${row.start_at}`)) continue;
      if (hasHistory(row)) {
        if (!row.removed_from_feed) { db.prepare('UPDATE event SET removed_from_feed = 1 WHERE id = ?').run(row.id); flagged++; }
      } else {
        for (const del of derived) del.run(row.id);
        db.prepare('DELETE FROM event WHERE id = ?').run(row.id);
        deleted++;
      }
    }
  });
  run();
  return { added, updated, flagged, deleted, merged, feed_events: vevents.length };
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
