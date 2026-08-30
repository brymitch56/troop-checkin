'use strict';
// Permission-form admin surface: settings route, per-event status endpoint,
// manual-override semantics on PATCH /events, the upload fallback, and the
// refresh endpoint's failure shape. SYNTHETIC DATA ONLY.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-permadm-'));
process.env.TLC_ENABLED = 'false'; // no live calls from tests, ever

const auth = require('../server/auth');
const { db } = require('../server/db');
const ps = require('../server/lib/permissionSync');

let server, base, adminCookie, evId;

async function req(method, url, { body, cookie, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

function exportBuffer(rows) {
  const XLSX = require('xlsx');
  const aoa = [['Synthetic (TEST)'],
    ['Member Number', 'Last Name', 'First Name', 'Event Permission Form'], ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'P');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin T', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await req('GET', '/api/staff-list')).json;
  adminCookie = (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staff[0].id, pin: 'adminpass' }),
  })).headers.get('set-cookie').split(';')[0];

  evId = Number(db.prepare(
    `INSERT INTO event (source, title, start_at, end_at, tlc_event_id,
                        requires_permission_form, permission_form_source)
     VALUES ('ical', 'Test Campout', datetime('now','+2 days'), datetime('now','+4 days'),
             'evtestadm01', 1, 'auto')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO person (is_youth, member_id, first_name, last_name, status)
              VALUES (1, 'Y-3001', 'Pat', 'Paddler', 'active')`).run();
});

after(() => server && server.close());

test('settings route: default off, PUT flips, admin-gated', async () => {
  assert.equal((await req('GET', '/api/admin/permission-forms')).status, 401);
  const s0 = (await req('GET', '/api/admin/permission-forms', { cookie: adminCookie })).json;
  assert.equal(s0.enabled, 0);
  const s1 = (await req('PUT', '/api/admin/permission-forms',
    { cookie: adminCookie, body: { enabled: 1 } })).json;
  assert.equal(s1.enabled, 1);
});

test('PATCH /events: manual requirement wins; "auto" hands control back', async () => {
  // manual clear
  let r = await req('PATCH', `/api/admin/events/${evId}`,
    { cookie: adminCookie, body: { requires_permission_form: 0 } });
  assert.equal(r.json.requires_permission_form, 0);
  assert.equal(r.json.permission_form_source, 'manual');
  // sweep data saying "required" must NOT override the manual clear
  ps.applyGrid([{ tlc_event_id: 'evtestadm01', et_slug: 'ettestadm01', required: 1 }]);
  assert.equal(db.prepare('SELECT requires_permission_form FROM event WHERE id = ?')
    .get(evId).requires_permission_form, 0);
  // hand back to auto → next sweep applies again
  r = await req('PATCH', `/api/admin/events/${evId}`,
    { cookie: adminCookie, body: { permission_form_source: 'auto' } });
  assert.equal(r.json.permission_form_source, 'auto');
  ps.applyGrid([{ tlc_event_id: 'evtestadm01', et_slug: 'ettestadm01', required: 1 }]);
  assert.equal(db.prepare('SELECT requires_permission_form FROM event WHERE id = ?')
    .get(evId).requires_permission_form, 1);
  // block flag round-trips
  r = await req('PATCH', `/api/admin/events/${evId}`,
    { cookie: adminCookie, body: { permission_block: true } });
  assert.equal(r.json.permission_block, 1);
});

test('form-upload fallback populates status; form-status reports it', async () => {
  const form = new FormData();
  form.append('file', new Blob([exportBuffer([
    ['Y-3001', 'Paddler', 'Pat', 'No'],
  ])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'event.xlsx');
  const up = await req('POST', `/api/admin/events/${evId}/form-upload`,
    { cookie: adminCookie, form });
  assert.equal(up.status, 200);
  assert.equal(up.json.stored, 1);

  const s = (await req('GET', `/api/admin/events/${evId}/form-status`, { cookie: adminCookie })).json;
  assert.equal(s.required, true);
  assert.equal(s.block, true);
  assert.equal(s.youth.length, 1);
  assert.equal(s.youth[0].signed, 0);
  assert.equal(s.youth[0].source, 'upload');
  assert.ok(s.fetched_at);

  // junk upload is rejected with a clear error
  const bad = new FormData();
  bad.append('file', new Blob([Buffer.from('<html>nope</html>')], { type: 'text/html' }), 'x.xlsx');
  const r2 = await req('POST', `/api/admin/events/${evId}/form-upload`, { cookie: adminCookie, form: bad });
  assert.equal(r2.status, 400);
});

test('refresh-forms surfaces TLC failure as 502, never a crash', async () => {
  const r = await req('POST', `/api/admin/events/${evId}/refresh-forms`,
    { cookie: adminCookie, body: {} });
  assert.equal(r.status, 502); // no TLC in tests — clean error path
  assert.ok(r.json.error);
});
