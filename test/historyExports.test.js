'use strict';
// Push-log + import-history endpoints: limit/date-range params and CSV
// exports (older rows must stay reachable past the old 30/50 caps).
// SYNTHETIC DATA ONLY.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hist-'));
process.env.TLC_ENABLED = 'false';

const auth = require('../server/auth');
const { db } = require('../server/db');

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

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin H', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await req('GET', '/api/staff-list')).json;
  adminCookie = (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staff[0].id, pin: 'adminpass' }),
  })).headers.get('set-cookie').split(';')[0];

  // 60 imports across two dates (old cap was 50) + a push-log backlog of 40
  // rows across two dates (old cap was 30)
  for (let i = 1; i <= 60; i++) {
    db.prepare(
      `INSERT INTO roster_import (filename, imported_at, added)
       VALUES (?, ?, ?)`
    ).run(`synthetic-${i}.xlsx`, i <= 20 ? '2026-07-01 12:00:00' : '2026-08-15 12:00:00', i);
  }
  const eid = Number(db.prepare(
    `INSERT INTO event (source, title, start_at, end_at) VALUES ('manual', 'History Event', '2026-08-01', '2026-08-02')`
  ).run().lastInsertRowid);
  // (event_id, person_id) is UNIQUE on the push table — one synthetic youth per row
  for (let i = 1; i <= 40; i++) {
    const pid = Number(db.prepare(
      `INSERT INTO person (is_youth, first_name, last_name, status) VALUES (1, 'Hank', ?, 'active')`
    ).run(`History${i}`).lastInsertRowid);
    db.prepare(
      `INSERT INTO tlc_attendance_push (person_id, event_id, tlc_event_id, status, created_at)
       VALUES (?, ?, 'evfakehist01', 'sent', ?)`
    ).run(pid, eid, i <= 10 ? '2026-07-05 10:00:00' : '2026-08-20 10:00:00');
  }
});

after(() => server && server.close());

test('imports: default cap 50, limit raises it, date range filters', async () => {
  assert.equal((await req('GET', '/api/admin/imports', { cookie: adminCookie })).json.length, 50);
  assert.equal((await req('GET', '/api/admin/imports?limit=1000', { cookie: adminCookie })).json.length, 60);
  const july = (await req('GET', '/api/admin/imports?limit=1000&from=2026-06-01&to=2026-07-31',
    { cookie: adminCookie })).json;
  assert.equal(july.length, 20); // the rows past the old cap are reachable
});

test('push-log: endpoint + range; CSVs carry the right shapes; all admin-gated', async () => {
  assert.equal((await req('GET', '/api/admin/push-log')).status, 401);
  assert.equal((await req('GET', '/api/admin/push-log', { cookie: adminCookie })).json.length, 30);
  assert.equal((await req('GET', '/api/admin/push-log?limit=1000', { cookie: adminCookie })).json.length, 40);
  const july = (await req('GET', '/api/admin/push-log?limit=1000&from=2026-07-01&to=2026-07-31',
    { cookie: adminCookie })).json;
  assert.equal(july.length, 10);

  const icsv = await req('GET', '/api/admin/export/imports.csv?limit=1000', { cookie: adminCookie });
  assert.match(icsv.text.split('\r\n')[0], /^imported_at,filename,staff,added/);
  assert.equal(icsv.text.trim().split('\r\n').length, 61); // header + 60
  const pcsv = await req('GET', '/api/admin/export/push-log.csv?limit=1000&from=2026-08-01',
    { cookie: adminCookie });
  assert.match(pcsv.text.split('\r\n')[0], /^queued_at,sent_at,status,attempts,person,event/);
  assert.equal(pcsv.text.trim().split('\r\n').length, 31); // header + 30 August rows
  assert.match(pcsv.text, /Hank History/);
});
