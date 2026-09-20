'use strict';
// A portal UID is <head>-<event id>-<tail>, and the tail changes whenever the
// event is edited in the portal. The sync used to key on the whole UID + start,
// so an edit looked like "old event gone, new event added": the form
// requirement, the block setting, hand-set adult tracking, cached form statuses
// and sign-ins stayed on a row flagged "gone from feed", the real event started
// from defaults, and the permission detector (which looks up by portal id) kept
// updating the ghost. Seen in production days before a campout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-icaledit-'));
require('../server/migrate');
const { db } = require('../server/db');
const { applyFeed } = require('../server/lib/icalSync');
const permSync = require('../server/lib/permissionSync');

// self-evidently fake portal ids; same shape as the real thing
const uid = (eventId, tail) => `fakehead00000000-${eventId}-${tail}`;
const at = (iso) => new Date(iso);
const ev = (u, title, start, end) => ({ type: 'VEVENT', uid: u, summary: title, start: at(start), end: at(end) });
const rowsFor = (eventId) => db.prepare(`SELECT * FROM event WHERE ical_uid LIKE ? ORDER BY id`).all(`%-${eventId}-%`);
const youth = db.prepare(`INSERT INTO person (is_youth, first_name, last_name) VALUES (1, 'Ben', 'Andrews')`).run().lastInsertRowid;
const staff = db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Test Door', 'door', 'x')`).run().lastInsertRowid;

test('an event edited in the portal (new UID tail, new start) keeps its row and everything on it', () => {
  const before = uid('evfake000001', '20260823t202202');
  applyFeed([ev(before, 'Fall Campout', '2026-09-25T21:00:00Z', '2026-09-27T15:00:00Z')]);
  const [orig] = rowsFor('evfake000001');
  // what a leader and the permission sync put on it
  db.prepare(`UPDATE event SET requires_permission_form = 1, permission_form_source = 'auto', permission_block = 1,
                               track_adults = 1, track_adults_source = 'manual', tlc_event_id = 'evfake000001' WHERE id = ?`).run(orig.id);
  db.prepare(`INSERT INTO event_form_status (event_id, person_id, signed) VALUES (?, ?, 1)`).run(orig.id, youth);
  db.prepare(`INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id) VALUES ('edit-test-1', ?, 'in', ?, ?)`)
    .run(orig.id, new Date().toISOString(), staff);

  // the portal edit: later start, earlier end, and therefore a NEW tail
  const after = uid('evfake000001', '20260913t144111');
  const r = applyFeed([ev(after, 'Fall Campout', '2026-09-25T22:30:00Z', '2026-09-27T14:00:00Z')]);

  const rows = rowsFor('evfake000001');
  assert.equal(rows.length, 1, 'still one row for this portal event');
  assert.equal(rows[0].id, orig.id, 'and it is the SAME row');
  assert.deepEqual({ added: r.added, updated: r.updated, flagged: r.flagged, deleted: r.deleted }, { added: 0, updated: 1, flagged: 0, deleted: 0 });
  assert.equal(rows[0].ical_uid, after);
  assert.equal(rows[0].start_at, '2026-09-25T22:30:00.000Z');
  assert.equal(rows[0].end_at, '2026-09-27T14:00:00.000Z');
  assert.equal(rows[0].removed_from_feed, 0);
  assert.deepEqual(
    { form: rows[0].requires_permission_form, block: rows[0].permission_block, adults: rows[0].track_adults, src: rows[0].track_adults_source },
    { form: 1, block: 1, adults: 1, src: 'manual' }, 'app-owned settings survive the edit');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM event_form_status WHERE event_id = ?').get(orig.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM txn WHERE event_id = ?').get(orig.id).n, 1);
  assert.equal(applyFeed([ev(after, 'Fall Campout', '2026-09-25T22:30:00Z', '2026-09-27T14:00:00Z')]).updated, 0, 'and the next sync is a no-op');
});

test('a pair ALREADY split by the old behaviour is folded back together', () => {
  // state the old code left behind: a flagged ghost carrying everything, and a
  // bare live row for the same portal event
  const ins = db.prepare(`INSERT INTO event (source, ical_uid, title, start_at, end_at, all_day, removed_from_feed,
                                             requires_permission_form, permission_form_source, permission_block, tlc_event_id,
                                             track_adults, track_adults_source)
                          VALUES ('ical', ?, 'Day Hike', ?, ?, 0, ?, ?, ?, ?, ?, 1, ?)`);
  const ghost = ins.run(uid('evfake000002', '20260801t090000'), '2026-10-03T13:00:00.000Z', '2026-10-03T20:00:00.000Z', 1, 1, 'auto', 1, 'evfake000002', 'manual').lastInsertRowid;
  const live = ins.run(uid('evfake000002', '20260902t101500'), '2026-10-03T14:00:00.000Z', '2026-10-03T20:00:00.000Z', 0, 0, null, 0, 'evfake000002', 'auto').lastInsertRowid;
  db.prepare(`INSERT INTO event_form_status (event_id, person_id, signed) VALUES (?, ?, 0)`).run(ghost, youth);
  db.prepare(`INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id) VALUES ('edit-test-2', ?, 'in', ?, ?)`)
    .run(ghost, new Date().toISOString(), staff);

  const feed = [
    ev(uid('evfake000001', '20260913t144111'), 'Fall Campout', '2026-09-25T22:30:00Z', '2026-09-27T14:00:00Z'),
    ev(uid('evfake000002', '20260902t101500'), 'Day Hike', '2026-10-03T14:00:00Z', '2026-10-03T20:00:00Z'),
  ];
  const r = applyFeed(feed);

  const rows = rowsFor('evfake000002');
  assert.equal(rows.length, 1, 'one row again');
  assert.equal(rows[0].id, ghost, 'the row that carried the settings and history is the one kept');
  assert.equal(r.merged, 1, 'the bare duplicate was folded away');
  assert.equal(db.prepare('SELECT 1 FROM event WHERE id = ?').get(live), undefined);
  assert.equal(rows[0].removed_from_feed, 0, 'no longer a ghost');
  assert.equal(rows[0].start_at, '2026-10-03T14:00:00.000Z', 'on the corrected time');
  assert.deepEqual({ form: rows[0].requires_permission_form, block: rows[0].permission_block, src: rows[0].track_adults_source },
    { form: 1, block: 1, src: 'manual' });
  assert.equal(applyFeed(feed).merged, 0);
});

test('when BOTH rows have their own sign-ins, neither is lost: the live one is current, the other stays flagged', () => {
  const ins = db.prepare(`INSERT INTO event (source, ical_uid, title, start_at, end_at, all_day, removed_from_feed, tlc_event_id)
                          VALUES ('ical', ?, 'Service Project', ?, ?, 0, ?, 'evfake000003')`);
  const old = ins.run(uid('evfake000003', '20260801t090000'), '2026-10-10T13:00:00.000Z', '2026-10-10T16:00:00.000Z', 1).lastInsertRowid;
  const cur = ins.run(uid('evfake000003', '20260905t080000'), '2026-10-10T14:00:00.000Z', '2026-10-10T17:00:00.000Z', 0).lastInsertRowid;
  for (const [i, id] of [old, cur].entries()) {
    db.prepare(`INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id) VALUES (?, ?, 'in', ?, ?)`)
      .run(`edit-test-3-${i}`, id, new Date().toISOString(), staff);
  }
  applyFeed([
    ev(uid('evfake000001', '20260913t144111'), 'Fall Campout', '2026-09-25T22:30:00Z', '2026-09-27T14:00:00Z'),
    ev(uid('evfake000002', '20260902t101500'), 'Day Hike', '2026-10-03T14:00:00Z', '2026-10-03T20:00:00Z'),
    ev(uid('evfake000003', '20260905t080000'), 'Service Project', '2026-10-10T14:00:00Z', '2026-10-10T17:00:00Z'),
  ]);
  const rows = rowsFor('evfake000003');
  assert.equal(rows.length, 2, 'sign-ins are never merged or dropped automatically');
  assert.equal(rows.find((x) => x.id === cur).removed_from_feed, 0);
  assert.equal(rows.find((x) => x.id === old).removed_from_feed, 1);

  // and the permission detector must address the LIVE row, not the first by id
  permSync.applyGrid([{ tlc_event_id: 'evfake000003', et_slug: 'etfakeslug001', required: 1 }]);
  assert.equal(db.prepare('SELECT requires_permission_form f FROM event WHERE id = ?').get(cur).f, 1, 'the live event is the one marked');
  assert.equal(db.prepare('SELECT requires_permission_form f FROM event WHERE id = ?').get(old).f, 0, 'the ghost is left alone');
});

test('UIDs with no portal id (manual or foreign feeds) keep the exact-match rule', () => {
  const r1 = applyFeed([ev('plain-uid-1', 'Open House', '2026-11-01T18:00:00Z', '2026-11-01T20:00:00Z')]);
  assert.equal(r1.added, 1);
  // same UID, different start: for a foreign feed that is a different occurrence, not an edit
  const r2 = applyFeed([ev('plain-uid-1', 'Open House', '2026-11-08T18:00:00Z', '2026-11-08T20:00:00Z')]);
  assert.equal(r2.added, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM event WHERE ical_uid = 'plain-uid-1'`).get().n, 1, 'the first occurrence, with nothing on it, was removed as before');
});

test('two feed entries sharing one portal id are left to the exact-match rule (never guessed at)', () => {
  const a = ev(uid('evfake000009', '20260901t000001'), 'Two-Part Event', '2026-12-01T18:00:00Z', '2026-12-01T20:00:00Z');
  const b = ev(uid('evfake000009', '20260901t000002'), 'Two-Part Event', '2026-12-02T18:00:00Z', '2026-12-02T20:00:00Z');
  const r = applyFeed([a, b]);
  assert.equal(r.added, 2);
  assert.equal(rowsFor('evfake000009').length, 2);
  assert.deepEqual({ ...applyFeed([a, b]), feed_events: 0 }, { added: 0, updated: 0, flagged: 0, deleted: 0, merged: 0, feed_events: 0 });
});
