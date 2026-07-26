'use strict';
// Membership-expiration alert: date normalization, 30-day boundary rules
// (day-granular like the events past-rule), the admin expiring list/CSV,
// the dashboard count, and snapshot inclusion for offline kiosks.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-memb-'));

const auth = require('../server/auth');
const { db } = require('../server/db');
const { normalizeDateCell, daysUntil, expiringPeople } = require('../server/lib/membership');

let server, base, doorCookie, adminCookie;

async function req(method, url, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv/non-JSON */ }
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') };
}

// day-granular helper: ISO date exactly n days from today (local)
const isoInDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const addPerson = (first, last, expires, extra = {}) =>
  Number(db.prepare(
    `INSERT INTO person (is_youth, member_id, first_name, last_name, membership_expires, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(extra.is_youth ?? 1, extra.member_id || null, first, last, expires, extra.status || 'active').lastInsertRowid);

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door T', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin T', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await req('GET', '/api/staff-list')).json;
  doorCookie = (await req('POST', '/api/login',
    { body: { staff_id: staff.find((s) => s.role === 'door').id, pin: '1234' } })).setCookie.split(';')[0];
  adminCookie = (await req('POST', '/api/login',
    { body: { staff_id: staff.find((s) => s.role === 'admin').id, pin: 'adminpass' } })).setCookie.split(';')[0];
});

after(() => server && server.close());

// ------------------------------------------------------- normalization ----
test('normalizeDateCell: ISO out for recognizable formats, raw otherwise', () => {
  assert.equal(normalizeDateCell('9/30/2026'), '2026-09-30');
  assert.equal(normalizeDateCell('12/5/26'), '2026-12-05');
  assert.equal(normalizeDateCell('2026-9-3'), '2026-09-03');
  assert.equal(normalizeDateCell('Aug 5, 2026'), '2026-08-05');
  assert.equal(normalizeDateCell('pending renewal'), 'pending renewal'); // kept raw
  assert.equal(normalizeDateCell(''), null);
  assert.equal(normalizeDateCell(null), null);
});

test('daysUntil: day-granular, defensive on junk', () => {
  assert.equal(daysUntil(isoInDays(0)), 0);    // expires today
  assert.equal(daysUntil(isoInDays(29)), 29);
  assert.equal(daysUntil(isoInDays(31)), 31);
  assert.equal(daysUntil(isoInDays(-5)), -5);  // lapsed
  assert.equal(daysUntil('pending renewal'), null);
  assert.equal(daysUntil(null), null);
});

// --------------------------------------------------- 30-day boundaries ----
test('expiringPeople: expires today and day 29 are in; day 31 is out', () => {
  addPerson('Today', 'Boundary', isoInDays(0), { member_id: 'B-1' });
  addPerson('DayTwentyNine', 'Boundary', isoInDays(29), { member_id: 'B-2' });
  addPerson('DayThirtyOne', 'Boundary', isoInDays(31), { member_id: 'B-3' });
  addPerson('Lapsed', 'Boundary', isoInDays(-10), { member_id: 'B-4' });
  addPerson('NoDate', 'Boundary', null, { member_id: 'B-5' });
  addPerson('Junk', 'Boundary', 'call the office', { member_id: 'B-6' });
  addPerson('Inactive', 'Boundary', isoInDays(1), { member_id: 'B-7', status: 'inactive' });
  addPerson('AdultExp', 'Boundary', isoInDays(10), { member_id: 'B-8', is_youth: 0 });

  const within30 = expiringPeople(30);
  const names = within30.map((p) => p.first_name);
  assert.ok(names.includes('Today'));
  assert.ok(names.includes('DayTwentyNine'));
  assert.ok(!names.includes('DayThirtyOne'));       // day 31: outside the window
  assert.ok(names.includes('Lapsed'));              // already expired still listed
  assert.ok(!names.includes('NoDate'));
  assert.ok(!names.includes('Junk'));               // unparseable = no date, no crash
  assert.ok(!names.includes('Inactive'));           // active members only
  assert.ok(names.includes('AdultExp'));            // registered adults chased too
  assert.equal(names[0], 'Lapsed');                 // most-lapsed first
  assert.equal(within30.find((p) => p.first_name === 'Today').days_left, 0);

  const within60 = expiringPeople(60);
  assert.ok(within60.map((p) => p.first_name).includes('DayThirtyOne')); // wider window
});

// ------------------------------------------------------ admin surfaces ----
test('GET /api/admin/expiring honors ?days= and requires admin', async () => {
  assert.equal((await req('GET', '/api/admin/expiring', { cookie: doorCookie })).status, 403);
  const r30 = await req('GET', '/api/admin/expiring?days=30', { cookie: adminCookie });
  assert.equal(r30.status, 200);
  const names30 = r30.json.map((p) => p.first_name);
  assert.ok(names30.includes('Today') && !names30.includes('DayThirtyOne'));
  const r60 = await req('GET', '/api/admin/expiring?days=60', { cookie: adminCookie });
  assert.ok(r60.json.map((p) => p.first_name).includes('DayThirtyOne'));
});

test('GET /api/admin/export/expiring.csv exports the window', async () => {
  const r = await req('GET', '/api/admin/export/expiring.csv?days=30', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.match(r.text, /last_name,first_name,type,member_number/);
  assert.match(r.text, /Boundary,Today/);
  assert.doesNotMatch(r.text, /DayThirtyOne/);
});

test('dashboard status includes expiring_30 count', async () => {
  const r = await req('GET', '/api/admin/status', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.expiring_30, expiringPeople(30).length);
  assert.ok(r.json.expiring_30 >= 4); // Today, DayTwentyNine, Lapsed, AdultExp
});

test('PATCH membership_expires by hand locks it against imports', async () => {
  const id = addPerson('Handedit', 'Lock', isoInDays(5), { member_id: 'B-9' });
  const r = await req('PATCH', `/api/admin/people/${id}`,
    { cookie: adminCookie, body: { membership_expires: isoInDays(200) } });
  assert.equal(r.status, 200);
  const p = db.prepare('SELECT * FROM person WHERE id = ?').get(id);
  assert.equal(p.membership_expires, isoInDays(200));
  assert.ok(JSON.parse(p.manual_fields).includes('membership_expires'));
});

// ---------------------------------------------- offline kiosk snapshot ----
test('roster snapshot carries membership_expires for offline warnings', async () => {
  const r = await req('GET', '/api/roster-snapshot', { cookie: doorCookie });
  assert.equal(r.status, 200);
  const today = r.json.people.find((p) => p.first_name === 'Today');
  assert.equal(today.membership_expires, isoInDays(0));
  // people with no date carry an explicit null (kiosk shows no tag)
  const noDate = r.json.people.find((p) => p.first_name === 'NoDate');
  assert.equal(noDate.membership_expires, null);
});
