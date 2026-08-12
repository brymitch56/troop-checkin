'use strict';
// Event auto-select window + overlap suggestion (/api/events/current) and
// concurrent sign-ins to overlapping events (/api/txn multi-open rules).
// Real server on an ephemeral port with an isolated temp DATA_DIR.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-evsel-'));

const auth = require('../server/auth');
const { db } = require('../server/db');

let server, base, doorCookie;
let uuidN = 0;
const uuid = () => `evsel-uuid-${++uuidN}`;
const MIN = 60000;
const at = (minFromNow) => new Date(Date.now() + minFromNow * MIN).toISOString();

async function req(method, url, { body, cookie } = {}) {
  const headers = { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

// adults only — adult carts need no signer/signature, so txn tests stay lean
function mkAdult(first, last) {
  return Number(db.prepare(
    `INSERT INTO person (first_name, last_name, is_youth, status) VALUES (?, ?, 0, 'active')`)
    .run(first, last).lastInsertRowid);
}
function mkEvent(title, startMin, endMin) {
  return Number(db.prepare(
    `INSERT INTO event (source, title, start_at, end_at, track_adults)
     VALUES ('manual', ?, ?, ?, 1)`)
    .run(title, at(startMin), at(endMin)).lastInsertRowid);
}
const clearEvents = () => {
  db.prepare('DELETE FROM txn_person').run();
  db.prepare('DELETE FROM txn').run();
  db.prepare('DELETE FROM event').run();
};
const signIn = (personId, eventId, extra = {}) => req('POST', '/api/txn', {
  cookie: doorCookie,
  body: { client_uuid: uuid(), direction: 'in', event_id: eventId, entries: [{ person_id: personId }], ...extra },
});
const signOut = (personId, eventId) => req('POST', '/api/txn', {
  cookie: doorCookie,
  body: { client_uuid: uuid(), direction: 'out', ...(eventId ? { event_id: eventId } : {}), entries: [{ person_id: personId }] },
});

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door T', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await req('GET', '/api/staff-list')).json;
  doorCookie = (await req('POST', '/api/login', { body: { staff_id: staff[0].id, pin: '1234' } }))
    .setCookie.split(';')[0];
});
after(() => server && server.close());

// ------------------------------------------------------------- window ------
test('events/current: matches from 30 min before start to 60 min after end', async () => {
  clearEvents();
  const soon = mkEvent('Starts in 20', 20, 120);       // pre-window
  const justOver = mkEvent('Ended 45 ago', -180, -45); // post-window
  const longOver = mkEvent('Ended 90 ago', -240, -90); // outside
  const later = mkEvent('Starts in 45', 45, 120);      // not yet

  const { json } = await req('GET', '/api/events/current', { cookie: doorCookie });
  const ids = json.matching.map((e) => e.id);
  assert.ok(ids.includes(soon), 'starting within 30 min should match');
  assert.ok(ids.includes(justOver), 'ended within the last hour should match');
  assert.ok(!ids.includes(longOver), 'ended over an hour ago must not match');
  assert.ok(!ids.includes(later), 'starting in 45 min must not match yet');
  assert.ok(json.upcoming.some((e) => e.id === later));
});

test('events/current: overlap suggestion follows the nearest sign-in/out rush', async () => {
  // mid-session event loses to one starting within 30 min
  clearEvents();
  let a = mkEvent('A mid-session', -60, 120);
  let b = mkEvent('B starts soon', 20, 120);
  let r = await req('GET', '/api/events/current', { cookie: doorCookie });
  assert.equal(r.json.suggested_id, b, 'mid-session A loses to soon-starting B');

  // event approaching its end wins back the kiosk
  clearEvents();
  a = mkEvent('A ending soon', -120, 15);
  b = mkEvent('B starts soon', 25, 120);
  r = await req('GET', '/api/events/current', { cookie: doorCookie });
  assert.equal(r.json.suggested_id, a, 'A approaching its end beats B');

  // just-ended event still wins over one mid-session
  clearEvents();
  a = mkEvent('A just ended', -120, -10);
  b = mkEvent('B mid-session', -30, 90);
  r = await req('GET', '/api/events/current', { cookie: doorCookie });
  assert.equal(r.json.suggested_id, a, 'just-ended A beats mid-session B');

  // single event: suggested trivially
  clearEvents();
  a = mkEvent('Solo', -10, 60);
  r = await req('GET', '/api/events/current', { cookie: doorCookie });
  assert.equal(r.json.suggested_id, a);
});

// ---------------------------------------------------------- multi-open -----
test('txn: same event twice is a conflict; a second event needs allow_multi', async () => {
  clearEvents();
  const evA = mkEvent('Campout', -60, 24 * 60);
  const evB = mkEvent('Meeting inside campout', -10, 90);
  const ann = mkAdult('Ann', 'Adams');

  assert.equal((await signIn(ann, evA)).status, 200);

  const dup = await signIn(ann, evA);
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.json.conflicts, ['Ann Adams']); // same message as before

  const second = await signIn(ann, evB);
  assert.equal(second.status, 409);
  assert.deepEqual(second.json.multi_open, [{ name: 'Ann Adams', events: ['Campout'] }]);

  assert.equal((await signIn(ann, evB, { allow_multi: true })).status, 200);
  const onsite = await req('GET', '/api/onsite', { cookie: doorCookie });
  assert.deepEqual(onsite.json.filter((p) => p.id === ann).map((p) => p.event_title).sort(),
    ['Campout', 'Meeting inside campout']);
});

test('txn: sign-out closes the selected event first, then the remaining open', async () => {
  const ann = db.prepare(`SELECT id FROM person WHERE first_name = 'Ann'`).get().id;
  const evA = db.prepare(`SELECT id FROM event WHERE title = 'Campout'`).get().id;
  const evB = db.prepare(`SELECT id FROM event WHERE title LIKE 'Meeting%'`).get().id;

  // no hint + two opens = explicit error, nothing guessed
  const noHint = await signOut(ann, null);
  assert.equal(noHint.status, 409);
  assert.equal(noHint.json.multi_open[0].name, 'Ann Adams');

  // selected-event hint closes ONLY that open
  assert.equal((await signOut(ann, evB)).status, 200);
  let onsite = await req('GET', '/api/onsite', { cookie: doorCookie });
  assert.deepEqual(onsite.json.filter((p) => p.id === ann).map((p) => p.event_title), ['Campout']);

  // one open left: no hint needed (the kiosk's selected event may differ)
  assert.equal((await signOut(ann, null)).status, 200);
  onsite = await req('GET', '/api/onsite', { cookie: doorCookie });
  assert.equal(onsite.json.filter((p) => p.id === ann).length, 0);

  // fully signed out now → the usual conflict
  const again = await signOut(ann, evA);
  assert.equal(again.status, 409);
  assert.match(again.json.error, /signed out/);
});
