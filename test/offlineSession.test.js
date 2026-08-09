'use strict';
// Event-aware session lifetimes (field lesson, 2026-08 weekend campout: the
// 6h door session expired mid-event with no signal to re-login, locking
// staff out of an otherwise offline-capable kiosk).
//
// Policy: DOOR sessions extend to cover any event that is ongoing or starts
// within 24h, plus 12 hours after its end. Admin sessions keep the strict
// 2h. Login and /me expose session_expires_at so the client caches it as
// the device's offline-entry window.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-osess-'));

const auth = require('../server/auth');
const { db } = require('../server/db');

let server, base;
const hoursFromNow = (iso) => (new Date(iso) - Date.now()) / 3600e3;

async function login(staffId, pin) {
  const res = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staffId, pin }),
  });
  return { status: res.status, json: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

let doorId, adminId;
before(async () => {
  require('../server/migrate');
  doorId = Number(db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door O', 'door', ?)`)
    .run(auth.hashSecret('1234')).lastInsertRowid);
  adminId = Number(db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin O', 'admin', ?)`)
    .run(auth.hashSecret('adminpass99')).lastInsertRowid);
  const app = require('../server/index');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

const off = (h) => `${h >= 0 ? '+' : ''}${h} hours`;
const insertEvent = (startOffsetH, endOffsetH, title) =>
  db.prepare(`INSERT INTO event (title, start_at, end_at, source)
              VALUES (?, datetime('now', ?), datetime('now', ?), 'manual')`)
    .run(title, off(startOffsetH), off(endOffsetH));

test('no event: door session gets the default ~6h and login exposes expiry', async () => {
  const r = await login(doorId, '1234');
  assert.equal(r.status, 200);
  assert.ok(r.json.session_expires_at, 'login returns session_expires_at');
  const h = hoursFromNow(r.json.session_expires_at);
  assert.ok(h > 5.9 && h < 6.1, `expected ~6h, got ${h}`);
});

test('ongoing long event: door session covers event end + 12h', async () => {
  insertEvent(-2, 30, 'Weekend Campout'); // started 2h ago, ends in 30h
  const r = await login(doorId, '1234');
  const h = hoursFromNow(r.json.session_expires_at);
  assert.ok(h > 41.9 && h < 42.1, `expected ~42h (30+12), got ${h}`); // end +12h
  // /me reports the same window (the client refreshes its cache from it)
  const me = await fetch(base + '/api/me', { headers: { cookie: r.cookie } });
  const meJson = await me.json();
  assert.equal(meJson.session_expires_at, r.json.session_expires_at);
  db.prepare(`DELETE FROM event WHERE title = 'Weekend Campout'`).run();
});

test('event starting within 24h counts; past and far-future events do not', async () => {
  insertEvent(20, 26, 'Tomorrow Meeting'); // starts in 20h, ends in 26h
  let h = hoursFromNow((await login(doorId, '1234')).json.session_expires_at);
  assert.ok(h > 37.9 && h < 38.1, `expected ~38h (26+12), got ${h}`);
  db.prepare(`DELETE FROM event WHERE title = 'Tomorrow Meeting'`).run();

  insertEvent(-50, -30, 'Last Week'); // ended 30h ago
  insertEvent(100, 110, 'Next Month'); // starts in 100h
  h = hoursFromNow((await login(doorId, '1234')).json.session_expires_at);
  assert.ok(h > 5.9 && h < 6.1, `expected default ~6h, got ${h}`);
  db.prepare(`DELETE FROM event WHERE title IN ('Last Week', 'Next Month')`).run();
});

test('short ongoing event never SHRINKS the session below the default', async () => {
  insertEvent(-1, 1, 'Quick Meeting'); // ends in 1h; 1+12=13h > 6h though
  let h = hoursFromNow((await login(doorId, '1234')).json.session_expires_at);
  assert.ok(h > 12.9 && h < 13.1, `expected ~13h, got ${h}`);
  db.prepare(`DELETE FROM event WHERE title = 'Quick Meeting'`).run();
});

test('admin sessions stay strict (~2h) even during a long event', async () => {
  insertEvent(-2, 30, 'Campout A');
  const r = await login(adminId, 'adminpass99');
  const h = hoursFromNow(r.json.session_expires_at);
  assert.ok(h > 1.9 && h < 2.1, `expected ~2h, got ${h}`);
  db.prepare(`DELETE FROM event WHERE title = 'Campout A'`).run();
});
