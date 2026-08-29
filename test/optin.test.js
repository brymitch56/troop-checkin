'use strict';
// Messaging opt-in trackers: youth semantics (all-unknown vs declined vs the
// mixed family that belongs in neither), adults' own-consent sections, the
// admin endpoint/CSV, and the dashboard counts. FAKE NAMES ONLY.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-optin-'));

const auth = require('../server/auth');
const { db } = require('../server/db');
const optin = require('../server/lib/optin');

let server, base, adminCookie;

async function req(method, url, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, json, text };
}

const addPerson = (first, last, extra = {}) =>
  Number(db.prepare(
    `INSERT INTO person (is_youth, first_name, last_name, status, sms_opt_in)
     VALUES (?, ?, ?, ?, ?)`
  ).run(extra.is_youth ?? 1, first, last, extra.status || 'active',
        extra.sms_opt_in || 'unknown').lastInsertRowid);

const link = (youthId, adultId, smsOptIn, extra = {}) => {
  db.prepare(
    `INSERT INTO person_guardian (youth_id, guardian_id, authorized, is_primary, source, sms_opt_in)
     VALUES (?, ?, ?, 0, 'manual', ?)`
  ).run(youthId, adultId, extra.authorized ?? 1, smsOptIn);
};

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

  const mom = addPerson('Mia', 'Mother', { is_youth: 0 });
  const dad = addPerson('Dan', 'Dad', { is_youth: 0 });
  const optedAdult = addPerson('Oli', 'Optin', { is_youth: 0, sms_opt_in: 'yes' });
  const stopAdult = addPerson('Stu', 'Stopped', { is_youth: 0, sms_opt_in: 'stop' });
  void optedAdult; void stopAdult;

  const unknownKid = addPerson('Una', 'Unknown');          // all links unknown
  link(unknownKid, mom, 'unknown');
  const orphanKid = addPerson('Orla', 'Orphan');           // no links at all
  void orphanKid;
  const declinedKid = addPerson('Deb', 'Declined');        // stop only
  link(declinedKid, mom, 'stop');
  const mixedKid = addPerson('Max', 'Mixed');              // yes + stop -> neither
  link(mixedKid, mom, 'yes');
  link(mixedKid, dad, 'stop');
  const optedKid = addPerson('Yara', 'Yes');               // yes only
  link(optedKid, mom, 'yes');
  const unauthKid = addPerson('Ned', 'Unauth');            // only link is UNauthorized
  link(unauthKid, dad, 'stop', { authorized: 0 });
  const goneKid = addPerson('Gus', 'Gone', { status: 'inactive' });
  void goneKid;
});

after(() => server && server.close());

test('youthNoOptIn: all-unknown families, linkless youth included, active only', () => {
  const names = optin.youthNoOptIn().map((p) => p.first_name);
  assert.deepEqual(names.sort(), ['Ned', 'Orla', 'Una'].sort()); // unauthorized-only = still no form on file
  const orla = optin.youthNoOptIn().find((p) => p.first_name === 'Orla');
  assert.equal(orla.guardian_count, 0); // UI can flag "no guardians linked"
});

test('youthDeclined: stop-and-no-yes; the mixed family is in neither list', () => {
  assert.deepEqual(optin.youthDeclined().map((p) => p.first_name), ['Deb']);
  const all = [...optin.youthNoOptIn(), ...optin.youthDeclined()].map((p) => p.first_name);
  assert.ok(!all.includes('Max'));  // mixed yes/stop is messageable
  assert.ok(!all.includes('Yara'));
  assert.ok(!all.includes('Gus'));
});

test('adultsByOptIn: adults sectioned by their own consent state', () => {
  assert.ok(optin.adultsByOptIn('unknown').some((p) => p.first_name === 'Mia'));
  assert.deepEqual(optin.adultsByOptIn('stop').map((p) => p.first_name), ['Stu']);
  assert.ok(!optin.adultsByOptIn('unknown').some((p) => p.first_name === 'Oli'));
});

test('GET /admin/optin-report: both views, youth + adults sections, admin-gated', async () => {
  assert.equal((await req('GET', '/api/admin/optin-report')).status, 401);
  const miss = (await req('GET', '/api/admin/optin-report?view=missing', { cookie: adminCookie })).json;
  assert.deepEqual(miss.youth.map((p) => p.first_name).sort(), ['Ned', 'Orla', 'Una'].sort());
  assert.ok(miss.adults.some((p) => p.first_name === 'Dan'));
  const dec = (await req('GET', '/api/admin/optin-report?view=declined', { cookie: adminCookie })).json;
  assert.deepEqual(dec.youth.map((p) => p.first_name), ['Deb']);
  assert.deepEqual(dec.adults.map((p) => p.first_name), ['Stu']);
});

test('opt-in CSV export includes both sections', async () => {
  const r = await req('GET', '/api/admin/export/optin.csv?view=declined', { cookie: adminCookie });
  assert.match(r.text, /Declined,Deb,youth/);
  assert.match(r.text, /Stopped,Stu,adult/);
});

test('dashboard status counts youth families (adults sectioned in the report)', async () => {
  const s = (await req('GET', '/api/admin/status', { cookie: adminCookie })).json;
  assert.equal(s.optin_missing, 3);   // Una, Orla, Ned
  assert.equal(s.optin_declined, 1);  // Deb
});
