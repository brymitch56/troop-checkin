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
  const isBare = (row) => !attached.some((q) => q.get(row.id)) && !MANUAL.some((c) => row[c] === 'manual') && !row.hidden;
  const feedPortalIds = new Map();
  for (const e of vevents) { const p = portalIdOf(e.uid); if (p) feedPortalIds.set(p, (feedPortalIds.get(p) || 0) + 1); }
  const rowsForPortalId = (pid) => db.prepare(
    `SELECT * FROM event WHERE source = 'ical' AND (tlc_event_id = ? OR ical_uid LIKE ? OR ical_uid LIKE ?) ORDER BY id`)
    .all(pid, `%-${pid}-%`, `%-${pid}@%`).filter((r) => r.tlc_event_id === pid || portalIdOf(r.ical_uid) === pid);
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
          // Keep the row that carries the most: history, then attachments or
          // hand-made settings, then the oldest.
          //
          // EXCEPT: a row that already holds this exact (uid, start) and is not
          // bare IS the keeper, whatever else exists. It cannot be folded away,
          // and the schema has UNIQUE (ical_uid, start_at), so moving the
          // identity onto another row while it stands is a constraint error —
          // which rolls back the WHOLE sync, every night (the frozen-calendar
          // failure, reintroduced). The other row then simply stays flagged
          // "gone from feed"; nothing is merged and nothing is lost.
          const score = (r) => (hasHistory(r) ? 4 : 0) + (isBare(r) ? 0 : 2);
          const keeper = ex && !isBare(ex)
            ? ex
            : rows.reduce((best, r) => (score(r) > score(best) ? r : best));
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
                              track_adults, track_adults_source, hidden)
           VALUES ('ical', ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?)`
        ).run(e.uid, title, location, description, startAt, endAt, allDay,
              require('./adultTracking').getSettings().default, e.fromExtraFeed ? 1 : 0);
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

// ---- several feeds, one calendar ---------------------------------------------
// A unit can subscribe to more than its own feed (its area, region, national
// office). They are fetched, merged and applied as ONE feed: applying them one
// at a time would read each feed's events as "gone" from the others and
// delete them. Feeds are identified in meta by a hash, never by URL — the URL
// holds the subscriber's private calendar token.
const crypto = require('crypto');
const feedKey = (url) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
const stampOf = (e) => new Date(e.lastmodified || e.dtstamp || 0).getTime() || 0;

// The same portal event can sit in two feeds (a unit event the area also
// lists). Keep one copy per (portal id or uid, start): the most recently
// edited one, so a stale copy in one feed never shadows an edit in another.
function mergeFeeds(feeds) {
  const byKey = new Map(), inFirst = new Set();
  feeds.forEach((list, i) => {
    for (const e of list) {
      const key = `${portalIdOf(e.uid) || e.uid}|${iso(e.start)}`;
      if (i === 0) inFirst.add(key);
      const prev = byKey.get(key);
      if (!prev || stampOf(e) > stampOf(prev)) byKey.set(key, e);
    }
  });
  // fromExtraFeed: only in an additional feed — such events start hidden
  return [...byKey].map(([key, e]) => Object.assign(e, { fromExtraFeed: !inFirst.has(key) }));
}

const readMeta = (key) => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
};
const writeMeta = (key, value) => db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));

async function syncIcal(urls = env.ICAL_URLS) {
  const list = (Array.isArray(urls) ? urls : String(urls || '').split(/[\s,]+/)).filter(Boolean);
  if (!list.length) throw new Error('ICAL_URL is not configured — set it in .env.');
  // Every feed must load, or nothing is applied: a feed that failed to load
  // would otherwise read as "all its events were cancelled".
  const feeds = [];
  for (let i = 0; i < list.length; i++) {
    let data;
    try { data = await ical.async.fromURL(list[i]); }
    catch (e) {
      throw new Error(`Calendar feed ${i + 1} of ${list.length} could not be loaded — nothing was changed ` +
        `(${String(e && e.message || e).replace(/https?:\/\/\S+/g, '<feed url>')})`);
    }
    feeds.push(Object.values(data).filter((e) => e.type === 'VEVENT' && e.uid && e.start && e.end));
  }
  // A feed with NO events is a portal hiccup, not a troop that cancelled its
  // whole calendar: on 2026-10-20 AHGfamily served one empty (but valid) feed
  // during a change on its side, and applying it deleted every event without
  // sign-ins and flagged the rest "gone from feed". Refuse it; the next sync
  // retries, and a refused sync never updates last_ical_sync, so the daily
  // freshness check notices if it keeps happening. With several feeds, the
  // same holds per feed: one that had events last time and now has none is
  // refused while anything upcoming is listed.
  const upcoming = db.prepare(`SELECT COUNT(*) n FROM event WHERE source = 'ical' AND removed_from_feed = 0
                                 AND datetime(end_at) > datetime('now')`).get().n;
  const lastCounts = readMeta('ical_feed_counts') || {};
  if (upcoming) {
    const allEmpty = feeds.every((f) => !f.length);
    const emptied = list.map((u, i) => (!feeds[i].length && lastCounts[feedKey(u)] > 0 ? i + 1 : 0)).filter(Boolean);
    if (allEmpty || emptied.length) {
      const which = list.length > 1 && !allEmpty ? ` (feed ${emptied.join(', ')} of ${list.length})` : '';
      throw new Error(`Calendar feed returned no events${which} while ${upcoming} upcoming event(s) are listed — ` +
        'not applied (looks like a portal outage). Nothing was changed; the next sync will try again.');
    }
  }
  const vevents = mergeFeeds(feeds);
  const result = applyFeed(vevents);
  if (list.length > 1) result.feeds = feeds.map((f) => f.length);
  writeMeta('ical_feed_counts', Object.fromEntries(list.map((u, i) => [feedKey(u), feeds[i].length])));
  writeMeta('last_ical_sync', { at: new Date().toISOString(), ...result });
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

module.exports = { syncIcal, applyFeed, mergeFeeds, scheduleNightly, deleteEventUnlessHistory };
