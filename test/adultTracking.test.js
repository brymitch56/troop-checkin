'use strict';
// Global adult-tracking default: new events start on it (kiosk/admin create
// and the iCal sync), changing it bulk-applies to current + future events
// that follow it, hand-set ('manual') and past events are never touched.
// Synthetic data only (public-repo PII rules).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-adults-'));

const auth = require('../server/auth');
const { db } = require('../server/db');

let server, base, adminCookie, doorCookie;
let uuidN = 0;
const uuid = () => `adult-uuid-${++uuidN}`;

async function req(method, url, { body, cookie } = {}) {
  const headers = cookie ? { cookie } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const ev = (id) => db.prepare(
  'SELECT track_adults AS t, track_adults_source AS s FROM event WHERE id = ?').get(id);
const createEvent = (title, extra = {}) => req('POST', '/api/events', {
  cookie: doorCookie, body: { title, start_at: hours(-1), end_at: hours(2), ...extra },
});

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin T', 'admin', ?)`)
    .run(auth.hashSecret('pw'));
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door T', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const a = await req('POST', '/api/login', { body: { staff_id: 1, pin: 'pw' } });
  adminCookie = a.headers.get('set-cookie').split(';')[0];
  const d = await req('POST', '/api/login', { body: { staff_id: 2, pin: '1234' } });
  doorCookie = d.headers.get('set-cookie').split(';')[0];
});

after(() => server && server.close());

test('default is OFF: unchanged behaviour for new events', async () => {
  const s = await req('GET', '/api/admin/adult-tracking', { cookie: adminCookie });
  assert.deepEqual(s.json, { default: 0 });
  assert.equal((await req('GET', '/api/config')).json.track_adults_default, 0);

  const plain = await createEvent('Weekly Meeting');
  assert.deepEqual(ev(plain.json.id), { t: 0, s: 'auto' });
  const ticked = await createEvent('Campout', { track_adults: true });
  assert.deepEqual(ev(ticked.json.id), { t: 1, s: 'manual' }); // differs from default: hand-set
  const unticked = await createEvent('Service Day', { track_adults: false });
  assert.deepEqual(ev(unticked.json.id), { t: 0, s: 'auto' }); // matches default: follows it
});

test('settings route: admin only, requires a value', async () => {
  assert.equal((await req('PUT', '/api/admin/adult-tracking', { cookie: doorCookie, body: { default: 1 } })).status, 403);
  assert.equal((await req('PUT', '/api/admin/adult-tracking', { cookie: adminCookie, body: {} })).status, 400);
});

test('turning the default ON bulk-applies to following events; manual and past are spared', async () => {
  const follows = (await createEvent('Follows Default')).json.id;
  const future = Number(db.prepare(
    `INSERT INTO event (source, title, start_at, end_at) VALUES ('manual', 'Legacy Future', ?, ?)`)
    .run(hours(48), hours(50)).lastInsertRowid); // pre-migration style row: source NULL
  const pinnedOff = (await createEvent('Pinned Youth-only')).json.id;
  await req('PATCH', `/api/admin/events/${pinnedOff}`, { cookie: adminCookie, body: { track_adults: false } });
  assert.deepEqual(ev(pinnedOff), { t: 0, s: 'manual' });
  const past = Number(db.prepare(
    `INSERT INTO event (source, title, start_at, end_at) VALUES ('manual', 'Old Meeting', ?, ?)`)
    .run(hours(-72), hours(-70)).lastInsertRowid);

  const r = await req('PUT', '/api/admin/adult-tracking', { cookie: adminCookie, body: { default: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.default, 1);
  assert.ok(r.json.applied >= 2);

  assert.deepEqual(ev(follows), { t: 1, s: 'auto' });
  assert.deepEqual(ev(future), { t: 1, s: 'auto' });
  assert.deepEqual(ev(pinnedOff), { t: 0, s: 'manual' }); // hand-set: untouched
  assert.deepEqual(ev(past), { t: 0, s: null });           // past: never rewritten
  assert.equal((await req('GET', '/api/config')).json.track_adults_default, 1);

  // saving the same value again is a no-op
  const again = await req('PUT', '/api/admin/adult-tracking', { cookie: adminCookie, body: { default: 1 } });
  assert.equal(again.json.applied, 0);
});

test('with the default ON: new events, iCal events, and adults at the kiosk', async () => {
  const plain = await createEvent('Plain Meeting');
  assert.deepEqual(ev(plain.json.id), { t: 1, s: 'auto' });
  const offByHand = await createEvent('Youth Only Night', { track_adults: false });
  assert.deepEqual(ev(offByHand.json.id), { t: 0, s: 'manual' });

  const { applyFeed } = require('../server/lib/icalSync');
  applyFeed([{ uid: 'uid-adults-test@example', summary: 'Feed Event', start: hours(24), end: hours(26) }]);
  const fed = db.prepare(`SELECT id FROM event WHERE ical_uid = 'uid-adults-test@example'`).get();
  assert.deepEqual(ev(fed.id), { t: 1, s: 'auto' });

  // an adult can now sign in at an event that only follows the default
  const adult = Number(db.prepare(
    `INSERT INTO person (is_youth, first_name, last_name, status) VALUES (0, 'Pat', 'Example', 'active')`)
    .run().lastInsertRowid);
  const inR = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: uuid(), direction: 'in', event_id: plain.json.id, entries: [{ person_id: adult }] },
  });
  assert.equal(inR.status, 200);
  // ...and is still refused at the event pinned youth-only
  const refused = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: uuid(), direction: 'in', event_id: offByHand.json.id, entries: [{ person_id: adult }], allow_multi: true },
  });
  assert.equal(refused.status, 422);
});

test('"follow global" hands a pinned event back and snaps it to the default', async () => {
  const pinned = (await createEvent('Pinned Then Released', { track_adults: false })).json.id;
  assert.deepEqual(ev(pinned), { t: 0, s: 'manual' });
  const r = await req('PATCH', `/api/admin/events/${pinned}`, {
    cookie: adminCookie, body: { track_adults_source: 'auto' },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(ev(pinned), { t: 1, s: 'auto' });

  // turning the default OFF again flips it back with the other followers
  const off = await req('PUT', '/api/admin/adult-tracking', { cookie: adminCookie, body: { default: 0 } });
  assert.ok(off.json.applied >= 1);
  assert.deepEqual(ev(pinned), { t: 0, s: 'auto' });
});
