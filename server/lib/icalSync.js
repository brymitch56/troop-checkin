'use strict';
// Trail Life Connect iCal feed sync (Phase 2).
// All events are discrete — no RRULE handling by design (see build plan).
// Rule: an ical event that disappears from the feed is DELETED if it has no
// transactions, but KEPT and flagged (removed_from_feed=1) if it has any.
const ical = require('node-ical');
const { db } = require('../db');
const env = require('./env');

const iso = (d) => new Date(d).toISOString();

function applyFeed(vevents) {
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
      const title = e.summary || '(untitled)';
      if (!ex) {
        db.prepare(
          `INSERT INTO event (source, ical_uid, title, location, description, start_at, end_at, all_day)
           VALUES ('ical', ?, ?, ?, ?, ?, ?, ?)`
        ).run(e.uid, title, e.location || null, e.description || null, startAt, endAt, allDay);
        added++;
      } else {
        const changed = ex.title !== title || ex.location !== (e.location || null) ||
          ex.description !== (e.description || null) || ex.end_at !== endAt ||
          ex.all_day !== allDay || ex.removed_from_feed !== 0;
        if (changed) { upd.run(title, e.location || null, e.description || null, endAt, allDay, ex.id); updated++; }
      }
    }
    for (const row of db.prepare(`SELECT * FROM event WHERE source = 'ical'`).all()) {
      if (seen.has(`${row.ical_uid}|${row.start_at}`)) continue;
      const hasTxn = db.prepare('SELECT 1 FROM txn WHERE event_id = ? LIMIT 1').get(row.id);
      if (hasTxn) {
        if (!row.removed_from_feed) { db.prepare('UPDATE event SET removed_from_feed = 1 WHERE id = ?').run(row.id); flagged++; }
      } else {
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

module.exports = { syncIcal, applyFeed, scheduleNightly };
