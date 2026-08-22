'use strict';
// Admin API (Phase 2): guardians authority rules, events, txn browser,
// void/close-open corrections, visitor merge, CSV exports, iCal apply rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admin-'));

const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const roster = require('../server/lib/rosterImport');
const auth = require('../server/auth');
const { db } = require('../server/db');
const { applyFeed } = require('../server/lib/icalSync');

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server, base, adminCookie, doorCookie;
let uuidN = 0;
const uuid = () => `adm-uuid-${++uuidN}`;
const person = (first) => db.prepare('SELECT * FROM person WHERE first_name = ?').get(first);

async function req(method, url, { body, cookie } = {}) {
  const headers = cookie ? { cookie } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv or html */ }
  return { status: res.status, json, text, headers: res.headers };
}

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin T', 'admin', ?)`)
    .run(auth.hashSecret('pw'));
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door T', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(people, roster.suggestLinks(people), null, 'seed.xlsx', null);
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const a = await req('POST', '/api/login', { body: { staff_id: 1, pin: 'pw' } });
  adminCookie = a.headers.get('set-cookie').split(';')[0];
  const d = await req('POST', '/api/login', { body: { staff_id: 2, pin: '1234' } });
  doorCookie = d.headers.get('set-cookie').split(';')[0];
});

after(() => server && server.close());

test('admin routes reject door sessions', async () => {
  assert.equal((await req('GET', '/api/admin/people', { cookie: doorCookie })).status, 403);
  assert.equal((await req('GET', '/api/admin/people')).status, 401);
});

test('people list, filters, and edit', async () => {
  const all = await req('GET', '/api/admin/people', { cookie: adminCookie });
  assert.equal(all.json.length, 6);
  const youth = await req('GET', '/api/admin/people?type=youth', { cookie: adminCookie });
  assert.equal(youth.json.length, 3);
  const upd = await req('PATCH', `/api/admin/people/${person('Danny').id}`, {
    cookie: adminCookie, body: { patrol: 'Falcons', notes: 'test note' },
  });
  assert.equal(upd.json.patrol, 'Falcons');
  await req('PATCH', `/api/admin/people/${person('Danny').id}`, { cookie: adminCookie, body: { patrol: 'Eagles' } });
});

test('guardian edits are authoritative: unauthorize survives, import links undeletable', async () => {
  const danny = person('Danny'), alice = person('Alice'), carol = person('Carol');
  // import link (Alice→Danny) cannot be deleted, only unauthorized
  const del = await req('DELETE', `/api/admin/people/${danny.id}/guardians/${alice.id}`, { cookie: adminCookie });
  assert.equal(del.status, 409);
  const un = await req('PATCH', `/api/admin/people/${danny.id}/guardians/${alice.id}`, {
    cookie: adminCookie, body: { authorized: false },
  });
  assert.equal(un.status, 200);
  // re-import must NOT restore authorization (link exists, import skips it)
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(people, roster.suggestLinks(people), null, 're.xlsx', null);
  const link = db.prepare('SELECT * FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(danny.id, alice.id);
  assert.equal(link.authorized, 0);
  assert.equal(link.source, 'manual'); // admin touch made it authoritative
  // manual add + primary handoff
  const add = await req('POST', `/api/admin/people/${danny.id}/guardians`, {
    cookie: adminCookie, body: { guardian_id: carol.id, relationship: 'aunt', is_primary: true },
  });
  assert.equal(add.status, 200);
  assert.equal(db.prepare('SELECT is_primary FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(danny.id, carol.id).is_primary, 1);
  assert.equal(db.prepare('SELECT is_primary FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(danny.id, alice.id).is_primary, 0);
  // manual links are deletable; restore Alice for later tests
  assert.equal((await req('DELETE', `/api/admin/people/${danny.id}/guardians/${carol.id}`, { cookie: adminCookie })).status, 200);
  await req('PATCH', `/api/admin/people/${danny.id}/guardians/${alice.id}`, {
    cookie: adminCookie, body: { authorized: true, is_primary: true },
  });
});

let eventId;
test('events: list, edit, delete rules', async () => {
  const mk = await req('POST', '/api/events', {
    cookie: adminCookie,
    body: {
      title: 'Campout', track_adults: true,
      start_at: new Date(Date.now() - 3600e3).toISOString(),
      end_at: new Date(Date.now() + 48 * 3600e3).toISOString(),
    },
  });
  eventId = mk.json.id;
  const ed = await req('PATCH', `/api/admin/events/${eventId}`, {
    cookie: adminCookie, body: { location: 'Camp Fake' },
  });
  assert.equal(ed.json.location, 'Camp Fake');
  const scratch = await req('POST', '/api/events', {
    cookie: adminCookie,
    body: { title: 'Scratch', start_at: new Date().toISOString(), end_at: new Date().toISOString() },
  });
  assert.equal((await req('DELETE', `/api/admin/events/${scratch.json.id}`, { cookie: adminCookie })).status, 200);
});

test('multi-day event: Friday sign-in, "Sunday" sign-out attaches to the same event (exit test)', async () => {
  const danny = person('Danny'), alice = person('Alice');
  const inR = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: {
      client_uuid: uuid(), direction: 'in', event_id: eventId,
      entries: [{ person_id: danny.id }], signer_person_id: alice.id, signature_data: PNG_1x1,
    },
  });
  assert.equal(inR.status, 200);
  // sign-out days later: no event_id supplied — must attach via the open record
  const outR = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: {
      client_uuid: uuid(), direction: 'out',
      signed_at: new Date(Date.now() + 44 * 3600e3).toISOString(),
      entries: [{ person_id: danny.id }], signer_person_id: alice.id, signature_data: PNG_1x1,
    },
  });
  assert.equal(outR.status, 200);
  const t = db.prepare('SELECT event_id FROM txn WHERE id = ?').get(outR.json.txn_id);
  assert.equal(t.event_id, eventId);
});

test('void a sign-out reopens the stay; void the sign-in closes it again', async () => {
  const emma = person('Emma'), bob = person('Bob');
  const inR = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: {
      client_uuid: uuid(), direction: 'in', event_id: eventId,
      entries: [{ person_id: emma.id }], signer_person_id: bob.id, signature_data: PNG_1x1,
    },
  });
  const outR = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: uuid(), direction: 'out', entries: [{ person_id: emma.id }], signer_person_id: bob.id, signature_data: PNG_1x1 },
  });
  const isOpen = () => !!db.prepare(
    `SELECT 1 FROM txn_person tp JOIN txn t ON t.id = tp.txn_id
      WHERE tp.person_id = ? AND tp.open = 1 AND t.voided_by_txn_id IS NULL`).get(emma.id);
  assert.equal(isOpen(), false);
  const v1 = await req('POST', `/api/admin/txns/${outR.json.txn_id}/void`, { cookie: adminCookie });
  assert.equal(v1.status, 200);
  assert.equal(isOpen(), true, 'voiding the sign-out should reopen the stay');
  assert.equal((await req('POST', `/api/admin/txns/${outR.json.txn_id}/void`, { cookie: adminCookie })).status, 409);
  const v2 = await req('POST', `/api/admin/txns/${inR.json.txn_id}/void`, { cookie: adminCookie });
  assert.equal(v2.status, 200);
  assert.equal(isOpen(), false, 'voiding the sign-in should close the stay');
});

test('admin close-open closes without a signature and is audited', async () => {
  const frank = person('Frank'), carol = person('Carol');
  await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: {
      client_uuid: uuid(), direction: 'in', event_id: eventId,
      entries: [{ person_id: frank.id }], signer_person_id: carol.id, signature_data: PNG_1x1,
    },
  });
  const r = await req('POST', '/api/admin/close-open', { cookie: adminCookie, body: { person_id: frank.id } });
  assert.equal(r.status, 200);
  const t = db.prepare('SELECT * FROM txn WHERE id = ?').get(r.json.txn_id);
  assert.equal(t.close_method, 'admin_close');
  assert.equal((await req('POST', '/api/admin/close-open', { cookie: adminCookie, body: { person_id: frank.id } })).status, 404);
});

test('txn browser lists and details', async () => {
  const list = await req('GET', `/api/admin/txns?event_id=${eventId}`, { cookie: adminCookie });
  assert.ok(list.json.length >= 5);
  const det = await req('GET', `/api/admin/txns/${list.json[0].id}`, { cookie: adminCookie });
  assert.ok(Array.isArray(det.json.entries));
});

test('visitor merge transfers history and links', async () => {
  // visitor youth who attended once
  const vis = await req('POST', '/api/visitor', {
    cookie: doorCookie,
    body: { first_name: 'Hank', last_name: 'Temp', is_youth: true, guardian_name: 'Helen Temp', guardian_phone: '555-0400', guardian_email: 'helen@example.com' },
  });
  const visId = vis.json.person.id;
  await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: {
      client_uuid: uuid(), direction: 'in', event_id: eventId,
      entries: [{ person_id: visId }],
      signer_person_id: db.prepare(`SELECT id FROM person WHERE first_name = 'Helen'`).get().id,
      signature_data: PNG_1x1,
    },
  });
  // youth/adult mismatch is rejected
  const bad = await req('POST', '/api/admin/merge', {
    cookie: adminCookie, body: { from_id: visId, into_id: person('Alice').id },
  });
  assert.equal(bad.status, 400);
  const r = await req('POST', '/api/admin/merge', {
    cookie: adminCookie, body: { from_id: visId, into_id: person('Danny').id },
  });
  assert.equal(r.status, 200);
  const merged = db.prepare('SELECT * FROM person WHERE id = ?').get(visId);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.merged_into_id, person('Danny').id);
  // Danny inherited the visitor's open sign-in and Helen as guardian
  const openRow = db.prepare(
    `SELECT 1 FROM txn_person tp JOIN txn t ON t.id = tp.txn_id
      WHERE tp.person_id = ? AND tp.open = 1 AND t.voided_by_txn_id IS NULL`).get(person('Danny').id);
  assert.ok(openRow, 'attendance transferred');
  await req('POST', '/api/admin/close-open', { cookie: adminCookie, body: { person_id: person('Danny').id } });
});

test('CSV exports produce well-formed files', async () => {
  const att = await req('GET', `/api/admin/export/attendance.csv?event_id=${eventId}`, { cookie: adminCookie });
  assert.equal(att.status, 200);
  assert.match(att.headers.get('content-type'), /text\/csv/);
  assert.match(att.text.split('\r\n')[0], /^event,last_name,first_name/);
  assert.ok(att.text.includes('Anderson'));
  const ov = await req('GET', '/api/admin/export/overrides.csv', { cookie: adminCookie });
  assert.equal(ov.status, 200);
  await req('POST', '/api/visitor', {
    cookie: doorCookie,
    body: { first_name: 'Ivy', last_name: 'Guest', is_youth: true, guardian_name: 'Iris Guest', guardian_phone: '555-0500', guardian_email: 'iris@example.com' },
  });
  const vis = await req('GET', '/api/admin/export/visitors.csv', { cookie: adminCookie });
  assert.ok(vis.text.includes('Guest'));
  assert.ok(vis.text.includes('guardian_email'), 'CSV carries the follow-up columns');
  assert.ok(vis.text.includes('iris@example.com'), 'guardian email rides along');
});

test('iCal applyFeed: add, update, removed-from-feed keep/flag vs delete', async () => {
  const mk = (uid, title, startMs, endMs) => ({
    type: 'VEVENT', uid, summary: title, start: new Date(startMs), end: new Date(endMs),
  });
  const t0 = Date.now();
  let r = applyFeed([mk('u1', 'Meeting A', t0, t0 + 3600e3), mk('u2', 'Meeting B', t0 + 86400e3, t0 + 90000e3)]);
  assert.equal(r.added, 2);
  // retitle A; feed drops B (no txns -> deleted)
  r = applyFeed([mk('u1', 'Meeting A (moved rooms)', t0, t0 + 3600e3)]);
  assert.equal(r.updated, 1);
  assert.equal(r.deleted, 1);
  const a = db.prepare(`SELECT * FROM event WHERE ical_uid = 'u1'`).get();
  assert.equal(a.title, 'Meeting A (moved rooms)');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM event WHERE ical_uid = 'u2'`).get().c, 0);
  // A gains a transaction, then vanishes from the feed -> kept + flagged
  db.prepare(`INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id)
              VALUES ('ical-keep-test', ?, 'in', ?, 1)`).run(a.id, new Date().toISOString());
  r = applyFeed([]);
  assert.equal(r.flagged, 1);
  const kept = db.prepare(`SELECT * FROM event WHERE ical_uid = 'u1'`).get();
  assert.equal(kept.removed_from_feed, 1);
  // and returning to the feed clears the flag
  r = applyFeed([mk('u1', 'Meeting A (moved rooms)', t0, t0 + 3600e3)]);
  assert.equal(r.updated, 1);
  assert.equal(db.prepare(`SELECT removed_from_feed FROM event WHERE ical_uid = 'u1'`).get().removed_from_feed, 0);
});

test('config endpoint exposes env branding, no auth required', async () => {
  const r = await req('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.ok(r.json.troop_id);
  const man = await req('GET', '/manifest.webmanifest');
  assert.equal(man.json.short_name, r.json.troop_id);
});

test('events: past hidden by default (day-granular), include_past reveals; kiosk picker shape', async () => {
  const day = 86400e3;
  const mk = (title, s, e) => db.prepare(
    `INSERT INTO event (source, title, start_at, end_at) VALUES ('manual', ?, ?, ?)`
  ).run(title, new Date(s).toISOString(), new Date(e).toISOString());
  mk('Ended Yesterday', Date.now() - 2 * day, Date.now() - day);
  // Anchor "today" to local midnight, NOT now-minus-hours: at 00:50 the old
  // fixture (now − 1h) landed on yesterday's date and correctly counted as
  // past, failing this test — caught by a CI run at 00:50 UTC (2026-07-27).
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  mk('Ends Today Earlier', todayStart.getTime() + 60e3, todayStart.getTime() + 2 * 60e3); // 00:01–00:02 today -> finish DATE is today -> not past
  mk('Next Month', Date.now() + 30 * day, Date.now() + 30 * day + 3600e3);

  const def = await req('GET', '/api/admin/events', { cookie: adminCookie });
  const names = def.json.map((e) => e.title);
  assert.ok(!names.includes('Ended Yesterday'), 'past event should be hidden by default');
  assert.ok(names.includes('Ends Today Earlier'), 'event finishing today is not past yet');
  assert.ok(names.includes('Next Month'));
  // upcoming sorted soonest-first
  const upcomingIdx = names.indexOf('Ends Today Earlier');
  assert.ok(upcomingIdx < names.indexOf('Next Month'), 'sorted current -> furthest away');

  const all = await req('GET', '/api/admin/events?include_past=1', { cookie: adminCookie });
  const withPast = all.json.map((e) => e.title);
  assert.ok(withPast.includes('Ended Yesterday'));
  assert.equal(all.json.find((e) => e.title === 'Ended Yesterday').is_past, 1);

  const cur = await req('GET', '/api/events/current', { cookie: doorCookie });
  assert.ok(Array.isArray(cur.json.upcoming) && Array.isArray(cur.json.past));
  assert.ok(cur.json.past.some((e) => e.title === 'Ended Yesterday'));
  assert.ok(cur.json.upcoming.some((e) => e.title === 'Next Month'));
  assert.ok(!cur.json.past.some((e) => e.title === 'Ends Today Earlier'));
});

test('staff management: create, PIN-overrides-password, guards', async () => {
  // door needs a PIN; admin needs a password
  assert.equal((await req('POST', '/api/admin/staff', { cookie: adminCookie, body: { name: 'X', role: 'door' } })).status, 400);
  assert.equal((await req('POST', '/api/admin/staff', { cookie: adminCookie, body: { name: 'X', role: 'admin' } })).status, 400);
  const mk = await req('POST', '/api/admin/staff', {
    cookie: adminCookie, body: { name: 'Second Admin', role: 'admin', password: 'pw2' },
  });
  assert.equal(mk.status, 200);
  const id = mk.json.id;
  // password login works
  const login1 = await req('POST', '/api/login', { body: { staff_id: id, pin: 'pw2' } });
  assert.equal(login1.status, 200);
  // setting a PIN overrides the password
  await req('PATCH', `/api/admin/staff/${id}`, { cookie: adminCookie, body: { pin: '9876' } });
  assert.equal((await req('POST', '/api/login', { body: { staff_id: id, pin: 'pw2' } })).status, 401, 'password must stop working once a PIN is set');
  assert.equal((await req('POST', '/api/login', { body: { staff_id: id, pin: '9876' } })).status, 200);
  // clearing the PIN restores the password
  await req('PATCH', `/api/admin/staff/${id}`, { cookie: adminCookie, body: { clear_pin: true } });
  assert.equal((await req('POST', '/api/login', { body: { staff_id: id, pin: 'pw2' } })).status, 200);
  // staff-list exposes has_pin for the kiosk input
  const sl = await req('GET', '/api/staff-list');
  assert.equal(sl.json.find((s) => s.name === 'Second Admin').has_pin, 0);
  // guards: cannot deactivate self; deactivating the other admin is fine, then
  // the remaining admin is protected as the last one
  assert.equal((await req('PATCH', '/api/admin/staff/1', { cookie: adminCookie, body: { active: false } })).status, 409);
  assert.equal((await req('PATCH', `/api/admin/staff/${id}`, { cookie: adminCookie, body: { active: false } })).status, 200);
  assert.equal((await req('PATCH', '/api/admin/staff/1', { cookie: adminCookie, body: { role: 'door' } })).status, 409);
  // deactivated staff can't log in and vanish from the kiosk picker
  assert.equal((await req('POST', '/api/login', { body: { staff_id: id, pin: 'pw2' } })).status, 401);
  assert.ok(!(await req('GET', '/api/staff-list')).json.some((s) => s.name === 'Second Admin'));
});

test('guardian-bulk: one adult + consent applied to several youth at once', async () => {
  const danny = person('Danny'), emma = person('Emma');
  const cf = db.prepare(`INSERT INTO consent_form (file_path, signed_by) VALUES ('fam.pdf', 'Nora Neighbor')`).run();
  const formId = Number(cf.lastInsertRowid);
  // opt-in without a form is refused before anything is written
  const gate = await req('POST', '/api/admin/guardian-bulk', {
    cookie: adminCookie,
    body: { new_guardian: { first_name: 'Nora', last_name: 'Neighbor' }, youth_ids: [danny.id, emma.id], opt_in: true },
  });
  assert.equal(gate.status, 422);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM person WHERE first_name = 'Nora'`).get().c, 0);
  // new adult -> linked + primary + opted in on BOTH youth in one call
  const r = await req('POST', '/api/admin/guardian-bulk', {
    cookie: adminCookie,
    body: {
      new_guardian: { first_name: 'Nora', last_name: 'Neighbor', phone_mobile: '555-0888' },
      youth_ids: [danny.id, emma.id], relationship: 'neighbor',
      is_primary: true, opt_in: true, consent_form_id: formId,
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.applied, 2);
  for (const y of [danny, emma]) {
    const link = db.prepare(
      'SELECT * FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(y.id, r.json.guardian_id);
    assert.equal(link.authorized, 1);
    assert.equal(link.is_primary, 1);
    assert.equal(link.sms_opt_in, 'yes');
    assert.equal(link.consent_form_id, formId);
    assert.equal(link.source, 'manual');
    // exactly one primary per youth (previous primaries demoted)
    assert.equal(db.prepare(
      'SELECT COUNT(*) c FROM person_guardian WHERE youth_id = ? AND is_primary = 1').get(y.id).c, 1);
  }
  // re-applying to an existing link updates instead of duplicating
  const again = await req('POST', '/api/admin/guardian-bulk', {
    cookie: adminCookie,
    body: { guardian_id: r.json.guardian_id, youth_ids: [danny.id], relationship: 'family friend' },
  });
  assert.equal(again.json.results[0].action, 'updated');
  assert.equal(db.prepare(
    'SELECT COUNT(*) c FROM person_guardian WHERE youth_id = ? AND guardian_id = ?')
    .get(danny.id, r.json.guardian_id).c, 1);
  assert.equal(db.prepare(
    'SELECT relationship, sms_opt_in FROM person_guardian WHERE youth_id = ? AND guardian_id = ?')
    .get(danny.id, r.json.guardian_id).relationship, 'family friend');
});

test('backup: VACUUM INTO snapshot restores onto a scratch DB (exit test)', async () => {
  const r = await req('POST', '/api/admin/backup', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(r.json.db));
  const Database = require('better-sqlite3');
  const scratch = new Database(r.json.db, { readonly: true });
  const people = scratch.prepare('SELECT COUNT(*) c FROM person').get().c;
  const txns = scratch.prepare('SELECT COUNT(*) c FROM txn').get().c;
  scratch.close();
  assert.equal(people, db.prepare('SELECT COUNT(*) c FROM person').get().c);
  assert.equal(txns, db.prepare('SELECT COUNT(*) c FROM txn').get().c);
});
