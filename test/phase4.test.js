'use strict';
// Phase 4-lite server pieces: roster snapshot endpoint + notification sweep.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-p4-'));

const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const roster = require('../server/lib/rosterImport');
const auth = require('../server/auth');
const { db } = require('../server/db');
const { sweep, findLingering } = require('../server/lib/notifySweep');

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server, base, cookie;
async function req(method, url, body) {
  const headers = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(people, roster.suggestLinks(people), null, 'seed.xlsx', null);
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: 1, pin: '1234' }),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => server && server.close());

test('roster snapshot: people, guardian links, badges, event window', async () => {
  db.prepare(`UPDATE person SET badge_code = 'Y-2001 | tok1' WHERE member_id = 'Y-2001'`).run();
  db.prepare(`INSERT INTO event (source, title, start_at, end_at)
              VALUES ('manual', 'Tonight', datetime('now', '-1 hour'), datetime('now', '+2 hours'))`).run();
  const r = await req('GET', '/api/roster-snapshot');
  assert.equal(r.status, 200);
  assert.equal(r.json.people.length, 6);
  assert.equal(r.json.links.length, 3);
  assert.deepEqual(r.json.badges, [{ id: db.prepare(`SELECT id FROM person WHERE member_id = 'Y-2001'`).get().id, badge_code: 'Y-2001 | tok1' }]);
  assert.equal(r.json.events.length, 1);
  assert.ok(r.json.people.every((p) => 'open' in p && 'last_emerg_phone_1' in p));
});

test('notification sweep: finds lingering youth after grace, dedupes per event', async () => {
  // event that ended 2 hours ago, youth still open
  const ev = db.prepare(`INSERT INTO event (source, title, start_at, end_at)
    VALUES ('manual', 'Ended Meeting', datetime('now', '-5 hours'), datetime('now', '-2 hours'))`).run();
  const evId = Number(ev.lastInsertRowid);
  const danny = db.prepare(`SELECT * FROM person WHERE member_id = 'Y-2001'`).get();
  const alice = db.prepare(`SELECT * FROM person WHERE first_name = 'Alice'`).get();
  const t = db.prepare(`INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id, signer_person_id)
    VALUES ('sweep-in', ?, 'in', datetime('now', '-5 hours'), 1, ?)`).run(evId, alice.id);
  db.prepare(`INSERT INTO txn_person (txn_id, person_id, open) VALUES (?, ?, 1)`)
    .run(Number(t.lastInsertRowid), danny.id);

  const lingering = findLingering();
  assert.equal(lingering.length, 1);
  assert.equal(lingering[0].person_id, danny.id);

  const r1 = sweep();
  assert.equal(r1.recorded, 1);
  const n = db.prepare('SELECT * FROM notification').all();
  assert.equal(n.length, 1);
  assert.equal(n[0].guardian_id, alice.id); // primary authorized guardian
  // second sweep: no duplicate notification
  assert.equal(sweep().recorded, 0);
  // grace period respected: event ending 10 min ago with default 30-min grace is NOT lingering
  const ev2 = db.prepare(`INSERT INTO event (source, title, start_at, end_at)
    VALUES ('manual', 'Just Ended', datetime('now', '-2 hours'), datetime('now', '-10 minutes'))`).run();
  const t2 = db.prepare(`INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id)
    VALUES ('sweep-in-2', ?, 'in', datetime('now', '-2 hours'), 1)`).run(Number(ev2.lastInsertRowid));
  const emma = db.prepare(`SELECT * FROM person WHERE member_id = 'Y-2002'`).get();
  db.prepare(`INSERT INTO txn_person (txn_id, person_id, open) VALUES (?, ?, 1)`)
    .run(Number(t2.lastInsertRowid), emma.id);
  assert.equal(findLingering().length, 1, 'still only the long-overdue youth');
});
