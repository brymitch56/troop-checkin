'use strict';
// An event that leaves the calendar feed is deleted unless something of
// record hangs off it. "Something of record" used to mean sign-ins only, but
// four more tables reference event(id) with no cascade. An off-feed event
// with no sign-ins and some cached permission-form statuses was "safe to
// delete", SQLite refused (FOREIGN KEY constraint failed), and because the
// sync is one transaction the WHOLE sync rolled back — every night, silently:
// no new events, no updates, no removals, until that one row was gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-icalrm-'));
require('../server/migrate');
const { db } = require('../server/db');
const { applyFeed, deleteEventUnlessHistory } = require('../server/lib/icalSync');

const HOUR = 3600e3;
const t0 = Date.parse('2026-10-06T22:30:00Z');
const mk = (uid, title, offsetDays = 0) => ({
  type: 'VEVENT', uid: `${uid}@example.com`, summary: title,
  start: new Date(t0 + offsetDays * 24 * HOUR), end: new Date(t0 + offsetDays * 24 * HOUR + 2 * HOUR),
});
const eventId = (uid) => (db.prepare('SELECT id FROM event WHERE ical_uid = ?').get(`${uid}@example.com`) || {}).id;
const count = (table, id) => db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE event_id = ?`).get(id).n;

const youth = db.prepare(`INSERT INTO person (is_youth, first_name, last_name) VALUES (1, 'Ben', 'Andrews')`).run().lastInsertRowid;
const parent = db.prepare(`INSERT INTO person (is_youth, first_name, last_name) VALUES (0, 'Dana', 'Andrews')`).run().lastInsertRowid;

test('off-feed event holding only cached form statuses is deleted — and the sync completes', () => {
  applyFeed([mk('stays', 'Weekly Meeting'), mk('campout', 'Fall Campout', 4)]);
  const campout = eventId('campout');
  db.prepare(`INSERT INTO event_form_status (event_id, person_id, signed) VALUES (?, ?, 1)`).run(campout, youth);
  db.prepare(`INSERT INTO event_form_status (event_id, person_id, signed, source) VALUES (?, ?, 0, 'upload')`).run(campout, parent);

  // the campout leaves the feed; a new event arrives in the same sync
  const r = applyFeed([mk('stays', 'Weekly Meeting'), mk('new', 'Service Project', 9)]);

  assert.deepEqual({ added: r.added, deleted: r.deleted, flagged: r.flagged }, { added: 1, deleted: 1, flagged: 0 });
  assert.equal(eventId('campout'), undefined, 'the off-feed event is gone');
  assert.equal(count('event_form_status', campout), 0, 'and its cached statuses went with it');
  assert.ok(eventId('new'), 'the rest of the sync was NOT rolled back');
});

test('off-feed event with history other than sign-ins is kept and flagged', () => {
  applyFeed([mk('stays', 'Weekly Meeting'), mk('new', 'Service Project', 9), mk('texted', 'Day Hike', 12), mk('pushed', 'Court of Honor', 15)]);
  const texted = eventId('texted'), pushed = eventId('pushed');
  db.prepare(`INSERT INTO notification (person_id, guardian_id, event_id) VALUES (?, ?, ?)`).run(youth, parent, texted);
  db.prepare(`INSERT INTO tlc_attendance_push (event_id, person_id, tlc_event_id) VALUES (?, ?, '<eventHashid>')`).run(pushed, youth);
  db.prepare(`INSERT INTO event_form_status (event_id, person_id, signed) VALUES (?, ?, 1)`).run(pushed, youth);

  const r = applyFeed([mk('stays', 'Weekly Meeting'), mk('new', 'Service Project', 9)]);

  assert.deepEqual({ deleted: r.deleted, flagged: r.flagged }, { deleted: 0, flagged: 2 });
  for (const id of [texted, pushed]) {
    assert.equal(db.prepare('SELECT removed_from_feed f FROM event WHERE id = ?').get(id).f, 1);
  }
  assert.equal(count('event_form_status', pushed), 1, 'a kept event keeps its form statuses too');
  assert.equal(applyFeed([mk('stays', 'Weekly Meeting'), mk('new', 'Service Project', 9)]).flagged, 0, 'flagging is not repeated');
});

test('every table that references event(id) is accounted for — no delete can hit a foreign key', () => {
  // If a migration adds a table pointing at event, applyFeed treats it as
  // history by default. This proves the default with a table it has never
  // heard of, rather than trusting the comment.
  db.exec(`CREATE TABLE future_feature (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES event(id))`);
  try {
    applyFeed([mk('stays', 'Weekly Meeting'), mk('new', 'Service Project', 9), mk('future', 'Open House', 20)]);
    const id = eventId('future');
    db.prepare('INSERT INTO future_feature (event_id) VALUES (?)').run(id);
    const r = applyFeed([mk('stays', 'Weekly Meeting'), mk('new', 'Service Project', 9)]);
    assert.equal(r.flagged, 1, 'kept and flagged, not a FOREIGN KEY error');
    assert.ok(db.prepare('SELECT 1 FROM event WHERE id = ?').get(id));
  } finally {
    db.exec('DELETE FROM future_feature; DROP TABLE future_feature;');
  }
});

test('deleteEventUnlessHistory (admin delete): clears cached statuses, refuses history', () => {
  applyFeed([mk('stays', 'Weekly Meeting'), mk('new', 'Service Project', 9), mk('plain', 'Planning Night', 25)]);
  const plain = eventId('plain');
  db.prepare(`INSERT INTO event_form_status (event_id, person_id, signed) VALUES (?, ?, 1)`).run(plain, youth);
  assert.equal(deleteEventUnlessHistory(plain), true);
  assert.equal(eventId('plain'), undefined);
  assert.equal(count('event_form_status', plain), 0);

  const texted = eventId('texted'); // has a notification, from the test above
  assert.equal(deleteEventUnlessHistory(texted), false);
  assert.ok(db.prepare('SELECT 1 FROM event WHERE id = ?').get(texted), 'an event with history is never deleted');
});
