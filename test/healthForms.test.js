'use strict';
// Health-form tracking: 12-month expiry math, missing/expiring queries for
// both tracked forms (health + the separate High Risk clearance), the admin
// endpoints/CSVs, and the dashboard counts. FAKE NAMES ONLY.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-health-'));

const auth = require('../server/auth');
const { db } = require('../server/db');
const hf = require('../server/lib/healthForms');

let server, base, adminCookie;

async function req(method, url, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv/non-JSON */ }
  return { status: res.status, json, text };
}

// ISO date exactly n days from today (local, day-granular)
const isoInDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// submission date whose 12-month expiry lands n days from today
const submittedExpiringIn = (n) => isoInDays(n - hf.HEALTH_FORM_VALID_DAYS);

const addPerson = (first, last, extra = {}) =>
  Number(db.prepare(
    `INSERT INTO person (is_youth, member_id, first_name, last_name, status,
                         health_form_date, high_risk_form_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(extra.is_youth ?? 1, extra.member_id || null, first, last,
        extra.status || 'active', extra.health || null, extra.high_risk || null).lastInsertRowid);

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin T', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await req('GET', '/api/staff-list')).json;
  adminCookie = (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staff[0].id, pin: 'adminpass' }),
  })).headers.get('set-cookie').split(';')[0];

  addPerson('Nora', 'None');                                         // youth, nothing on file
  addPerson('Sam', 'Soon', { health: submittedExpiringIn(10) });     // expires in 10 days
  addPerson('Fay', 'Fresh', { health: submittedExpiringIn(300) });   // fresh form
  addPerson('Leo', 'Lapsed', { health: submittedExpiringIn(-40) });  // expired 40 days ago
  addPerson('Ada', 'Adult', { is_youth: 0, health: submittedExpiringIn(5), high_risk: submittedExpiringIn(20) });
  addPerson('Gus', 'Gone', { status: 'inactive' });                  // inactive: never counted
  addPerson('Raw', 'Junk', { health: 'pending upload' });            // unparseable: on file, never expiring
});

after(() => server && server.close());

test('expiryOf: submission + 12 months, defensive on junk', () => {
  assert.equal(hf.expiryOf('2026-03-01'), '2027-03-01');
  assert.equal(hf.expiryOf(null), null);
  assert.equal(hf.expiryOf('pending upload'), null);
});

test('missingPeople: active people with no date, both forms tracked separately', () => {
  const missing = hf.missingPeople('health').map((p) => p.first_name);
  assert.ok(missing.includes('Nora'));
  assert.ok(!missing.includes('Gus'));       // inactive
  assert.ok(!missing.includes('Raw'));       // unparseable is still "on file"
  assert.ok(!missing.includes('Sam'));
  // Sam has a health form but no High Risk clearance — separate fields
  const hrMissing = hf.missingPeople('high_risk').map((p) => p.first_name);
  assert.ok(hrMissing.includes('Sam'));
  assert.ok(!hrMissing.includes('Ada'));
  assert.throws(() => hf.missingPeople('nope'), /Unknown form/);
});

test('expiringPeople: 30-day window includes expired, sorted most-lapsed first', () => {
  const rows = hf.expiringPeople('health', 30);
  assert.deepEqual(rows.map((p) => p.first_name), ['Leo', 'Ada', 'Sam']);
  assert.equal(rows[0].days_left, -40);
  assert.equal(rows[2].days_left, 10);
  assert.equal(rows[2].expires_on, isoInDays(10));
  assert.equal(hf.expiringPeople('health', 5).length, 2);  // Leo + Ada only
  const hr = hf.expiringPeople('high_risk', 30);
  assert.deepEqual(hr.map((p) => p.first_name), ['Ada']);  // high-risk separate
});

test('GET /admin/health-forms: both views, form selection, admin-gated', async () => {
  assert.equal((await req('GET', '/api/admin/health-forms')).status, 401);
  const miss = await req('GET', '/api/admin/health-forms?form=health&view=missing', { cookie: adminCookie });
  assert.equal(miss.status, 200);
  assert.ok(miss.json.some((p) => p.first_name === 'Nora'));
  const exp = await req('GET', '/api/admin/health-forms?form=health&view=expiring&days=30', { cookie: adminCookie });
  assert.deepEqual(exp.json.map((p) => p.first_name), ['Leo', 'Ada', 'Sam']);
  const hr = await req('GET', '/api/admin/health-forms?form=high_risk&view=expiring', { cookie: adminCookie });
  assert.deepEqual(hr.json.map((p) => p.first_name), ['Ada']);
});

test('health-forms CSV exports carry the right columns per view', async () => {
  const exp = await req('GET', '/api/admin/export/health-forms.csv?form=health&view=expiring&days=30', { cookie: adminCookie });
  assert.match(exp.text, /submitted_on,expires_on,days_left/);
  assert.match(exp.text, /Soon,Sam/);
  const miss = await req('GET', '/api/admin/export/health-forms.csv?form=health&view=missing', { cookie: adminCookie });
  assert.ok(!/submitted_on/.test(miss.text)); // no date columns on the missing view
  assert.match(miss.text, /None,Nora/);
});

test('dashboard status carries all four health-form counts', async () => {
  const s = (await req('GET', '/api/admin/status', { cookie: adminCookie })).json;
  assert.equal(s.health_expiring_30, 3);            // Leo, Ada, Sam
  assert.equal(s.high_risk_expiring_30, 1);         // Ada
  assert.ok(s.health_missing >= 1);                 // Nora (+ any staff-free defaults)
  assert.ok(s.high_risk_missing > s.health_missing); // almost nobody has a High Risk form
});

test('hand-editing a form date locks it against imports (manual_fields)', async () => {
  const nora = db.prepare(`SELECT id FROM person WHERE first_name = 'Nora'`).get();
  const r = await req('PATCH', `/api/admin/people/${nora.id}`,
    { cookie: adminCookie, body: { health_form_date: '2026-08-01' } });
  assert.equal(r.status, 200);
  const after = db.prepare('SELECT health_form_date, manual_fields FROM person WHERE id = ?').get(nora.id);
  assert.equal(after.health_form_date, '2026-08-01');
  assert.ok(JSON.parse(after.manual_fields).includes('health_form_date'));
});
