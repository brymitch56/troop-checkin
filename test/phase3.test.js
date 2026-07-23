'use strict';
// Phase 3 + roster-protection features: Twilio signature validation, inbound
// webhook (STOP / Y closes), manual-field import locking, consent-form
// authorized adults, report queries, photo upload.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-p3-'));
process.env.SMS_ENABLED = 'true';
process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_FROM_NUMBER = '+15550100000';

const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const roster = require('../server/lib/rosterImport');
const auth = require('../server/auth');
const { db } = require('../server/db');
const sms = require('../server/lib/sms');

const PNG_1x1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_1x1 = 'data:image/png;base64,' + PNG_1x1_B64;

let server, base, adminCookie, doorCookie;
let uuidN = 0;
const uuid = () => `p3-${++uuidN}`;
const person = (first) => db.prepare('SELECT * FROM person WHERE first_name = ?').get(first);

async function req(method, url, { body, cookie, form, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (typeof body === 'string') payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* xml/csv */ }
  return { status: res.status, json, text };
}

// Twilio-style signed webhook POST
function twilioPost(url, params) {
  const fullUrl = process.env.PUBLIC_URL + url;
  let data = fullUrl;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const sig = crypto.createHmac('sha1', 'test_auth_token').update(Buffer.from(data, 'utf8')).digest('base64');
  return req('POST', url, {
    body: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
  });
}

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin P3', 'admin', ?)`)
    .run(auth.hashSecret('pw'));
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door P3', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(people, roster.suggestLinks(people), null, 'seed.xlsx', null);
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = base; // webhook signatures validate against this
  const a = await req('POST', '/api/login', { body: { staff_id: 1, pin: 'pw' } });
  adminCookie = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staff_id: 1, pin: 'pw' }) })).headers.get('set-cookie').split(';')[0];
  doorCookie = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staff_id: 2, pin: '1234' }) })).headers.get('set-cookie').split(';')[0];
  assert.equal(a.status, 200);
});
after(() => server && server.close());

// ------------------------------------------------------------------- sms ----
test('sms helpers: phone normalization and signature validation', () => {
  assert.equal(sms.normPhone('(555) 010-2345'), '5550102345');
  assert.equal(sms.normPhone('+1 555 010 2345'), '5550102345');
  assert.equal(sms.e164('5550102345'), '+15550102345');
  const url = 'https://x.example/api/sms/inbound';
  const params = { From: '+15550102345', Body: 'Y' };
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const good = crypto.createHmac('sha1', 'test_auth_token').update(data).digest('base64');
  assert.equal(sms.validateSignature(good, url, params), true);
  assert.equal(sms.validateSignature('bogus', url, params), false);
});

test('webhook rejects unsigned requests', async () => {
  const r = await req('POST', '/api/sms/inbound', {
    body: 'From=%2B15550102345&Body=Y',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(r.status, 403);
});

test('webhook: Y from a notified guardian closes the open sign-in (sms_confirm)', async () => {
  const danny = person('Danny'), alice = person('Alice');
  db.prepare('UPDATE person SET phone_mobile = ? WHERE id = ?').run('555-0101', alice.id);
  // consent recorded: form on file + opt-in (sends are gated on this)
  const cf = db.prepare(`INSERT INTO consent_form (file_path, signed_by) VALUES ('t.pdf', 'Alice Anderson')`).run();
  db.prepare(`UPDATE person_guardian SET sms_opt_in = 'yes', consent_form_id = ?
               WHERE guardian_id = ? AND youth_id = ?`)
    .run(Number(cf.lastInsertRowid), alice.id, danny.id);
  // sign Danny in at an event that has ended, then simulate the sweep notification
  const ev = db.prepare(`INSERT INTO event (source, title, start_at, end_at)
    VALUES ('manual', 'Ended', datetime('now', '-4 hours'), datetime('now', '-2 hours'))`).run();
  const evId = Number(ev.lastInsertRowid);
  const inR = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: {
      client_uuid: uuid(), direction: 'in', event_id: evId,
      entries: [{ person_id: danny.id }], signer_person_id: alice.id, signature_data: PNG_1x1,
    },
  });
  assert.equal(inR.status, 200);
  const swept = await require('../server/lib/notifySweep').sweep(); // send fails (fake creds) but records
  assert.ok(swept.recorded >= 1);
  db.prepare(`UPDATE notification SET status = 'sent' WHERE person_id = ?`).run(danny.id);

  const y = await twilioPost('/api/sms/inbound', { From: '+15550101', Body: 'Y' });
  // wrong number: nothing closed
  assert.match(y.text, /No open check-ins/);

  const y2 = await twilioPost('/api/sms/inbound', { From: '(555) 0101', Body: 'y' });
  assert.equal(y2.status, 200);
  assert.match(y2.text, /marked as picked up/);
  const open = db.prepare(
    `SELECT 1 FROM txn_person tp JOIN txn t ON t.id = tp.txn_id
      WHERE tp.person_id = ? AND tp.open = 1 AND t.voided_by_txn_id IS NULL`).get(danny.id);
  assert.equal(open, undefined);
  const closer = db.prepare(
    `SELECT close_method FROM txn WHERE event_id = ? AND direction = 'out' ORDER BY id DESC`).get(evId);
  assert.equal(closer.close_method, 'sms_confirm');
  assert.equal(db.prepare(`SELECT status FROM notification WHERE person_id = ?`).get(danny.id).status, 'replied_y');
});

test('webhook: STOP sets opt-out; START only restores pairs with recorded consent', async () => {
  const alice = person('Alice');
  const stop = await twilioPost('/api/sms/inbound', { From: '5550101', Body: 'STOP' });
  assert.equal(stop.status, 200);
  const optIns = db.prepare(
    `SELECT sms_opt_in FROM person_guardian WHERE guardian_id = ?`).all(alice.id);
  assert.ok(optIns.every((r) => r.sms_opt_in === 'stop'));
  // one of Alice's links has a consent form (set in the previous test); strip
  // it from any others to prove START never manufactures consent
  const links = db.prepare(
    `SELECT youth_id, consent_form_id FROM person_guardian WHERE guardian_id = ?`).all(alice.id);
  const start = await twilioPost('/api/sms/inbound', { From: '5550101', Body: 'START' });
  assert.equal(start.status, 200);
  for (const l of links) {
    const after = db.prepare(
      `SELECT sms_opt_in FROM person_guardian WHERE guardian_id = ? AND youth_id = ?`)
      .get(alice.id, l.youth_id);
    assert.equal(after.sms_opt_in, l.consent_form_id ? 'yes' : 'stop',
      'START restores only consented pairs');
  }
});

// -------------------------------------------------- import-lock protection ----
test('manual edits lock fields against re-imports; clear_manual unlocks', async () => {
  const danny = person('Danny');
  // admin fixes Danny's patrol by hand
  const upd = await req('PATCH', `/api/admin/people/${danny.id}`, {
    cookie: adminCookie, body: { patrol: 'Ravens' },
  });
  assert.equal(upd.json.patrol, 'Ravens');
  assert.deepEqual(JSON.parse(upd.json.manual_fields), ['patrol']);
  // re-import (file says Eagles) must NOT clobber the manual value
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(people, [], null, 're.xlsx', null);
  assert.equal(person('Danny').patrol, 'Ravens');
  // other fields still update from the file, and unlock restores import control
  const cleared = await req('PATCH', `/api/admin/people/${danny.id}`, {
    cookie: adminCookie, body: { clear_manual: true },
  });
  assert.equal(cleared.json.manual_fields, null);
  roster.applyImport(roster.parseWorkbook(buildWorkbookBuffer()), [], null, 're2.xlsx', null);
  assert.equal(person('Danny').patrol, 'Eagles'); // file value again
});

// ------------------------------------------------- consent-form designees ----
test('consent form: brand-new adult becomes an authorized pickup, can be primary', async () => {
  const emma = person('Emma');
  const r = await req('POST', `/api/admin/people/${emma.id}/guardians/new`, {
    cookie: adminCookie,
    body: { first_name: 'Greta', last_name: 'Neighbor', phone_mobile: '555-0777', relationship: 'family friend', is_primary: true },
  });
  assert.equal(r.status, 200);
  const link = db.prepare(
    `SELECT pg.*, g.first_name, g.member_id FROM person_guardian pg
       JOIN person g ON g.id = pg.guardian_id
      WHERE pg.youth_id = ? AND pg.guardian_id = ?`).get(emma.id, r.json.guardian_id);
  assert.equal(link.first_name, 'Greta');
  assert.equal(link.member_id, null); // not a roster member — imports can't touch her
  assert.equal(link.authorized, 1);
  assert.equal(link.is_primary, 1);
  assert.equal(link.source, 'manual');
  // previous primary (Bob) demoted, exactly one primary remains
  const primaries = db.prepare(
    'SELECT COUNT(*) c FROM person_guardian WHERE youth_id = ? AND is_primary = 1').get(emma.id).c;
  assert.equal(primaries, 1);
  // she appears in the kiosk guardians list for signing
  const g = await req('GET', `/api/person/${emma.id}/guardians`, { cookie: doorCookie });
  assert.ok(g.json.some((x) => x.first_name === 'Greta'));
  // and re-import never removes or duplicates the link
  roster.applyImport(roster.parseWorkbook(buildWorkbookBuffer()), [], null, 're3.xlsx', null);
  assert.equal(db.prepare(
    'SELECT COUNT(*) c FROM person_guardian WHERE youth_id = ? AND guardian_id = ?')
    .get(emma.id, r.json.guardian_id).c, 1);
});

// ------------------------------------------------------- SMS consent gate ----
test('consent forms: upload, opt-in requires a form, CSV export', async () => {
  const emma = person('Emma'), bob = person('Bob');
  // opting in without a consent form is refused
  const bare = await req('PATCH', `/api/admin/people/${emma.id}/guardians/${bob.id}`, {
    cookie: adminCookie, body: { sms_opt_in: 'yes' },
  });
  assert.equal(bare.status, 422);
  // upload a scanned form
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'brown-family.pdf');
  form.append('signed_by', 'Bob Brown');
  form.append('signed_on', '2026-07-20');
  const up = await req('POST', '/api/admin/consent-forms', { form, cookie: adminCookie });
  assert.equal(up.status, 200);
  const formId = up.json.id;
  // now opt-in works, and the same form can cover another pair (cross-link)
  const ok = await req('PATCH', `/api/admin/people/${emma.id}/guardians/${bob.id}`, {
    cookie: adminCookie, body: { sms_opt_in: 'yes', consent_form_id: formId },
  });
  assert.equal(ok.status, 200);
  // form is served session-gated
  assert.equal((await fetch(`${base}/consent-forms/${up.json.file_path}`, { headers: { cookie: doorCookie } })).status, 200);
  assert.equal((await fetch(`${base}/consent-forms/${up.json.file_path}`)).status, 401);
  // listed with link count
  const list = await req('GET', '/api/admin/consent-forms', { cookie: adminCookie });
  assert.ok(list.json.find((f) => f.id === formId).linked_pairs >= 1);
  // compliance CSV
  const csv = await req('GET', '/api/admin/export/sms-consent.csv', { cookie: adminCookie });
  assert.match(csv.text.split('\r\n')[0], /^youth_last,youth_first,guardian_last/);
  assert.ok(csv.text.includes('Bob Brown'));
});

test('kiosk notify-onsite: opt-in gating with per-youth skip reasons and dedupe', async () => {
  const emma = person('Emma'), frank = person('Frank'), bob = person('Bob'), carol = person('Carol');
  db.prepare('UPDATE person SET phone_mobile = ? WHERE id = ?').run('555-0102', bob.id);
  // fresh event, sign in Emma (Bob opted in above) and Frank (Carol: no consent)
  const ev = db.prepare(`INSERT INTO event (source, title, start_at, end_at, track_adults)
    VALUES ('manual', 'Notify Test', datetime('now', '-1 hour'), datetime('now', '+2 hours'), 0)`).run();
  const evId = Number(ev.lastInsertRowid);
  for (const [youth, signer] of [[emma, bob], [frank, carol]]) {
    const r = await req('POST', '/api/txn', {
      cookie: doorCookie,
      body: {
        client_uuid: uuid(), direction: 'in', event_id: evId,
        entries: [{ person_id: youth.id }], signer_person_id: signer.id, signature_data: PNG_1x1,
      },
    });
    assert.equal(r.status, 200);
  }
  const r = await req('POST', '/api/notify-onsite', { cookie: doorCookie, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.onsite_youth, 2);
  // Frank must be skipped for lack of consent; Emma's attempt goes to the send
  // path (fake Twilio creds -> recorded as failed) — never silently dropped
  const frankRow = r.json.skipped.find((s) => s.youth.includes('Frank'));
  assert.ok(frankRow && /no opted-in guardian/.test(frankRow.reason));
  const emmaAttempted = r.json.sent.some((s) => s.youth.includes('Emma')) ||
    r.json.skipped.some((s) => s.youth.includes('Emma') && /send failed/.test(s.reason));
  assert.ok(emmaAttempted, 'opted-in youth must be attempted');
  assert.equal(db.prepare(
    'SELECT COUNT(*) c FROM notification WHERE person_id = ? AND event_id = ?').get(emma.id, evId).c, 1);
  // second press: dedupe — Emma reported as already notified
  const r2 = await req('POST', '/api/notify-onsite', { cookie: doorCookie, body: {} });
  assert.ok(r2.json.skipped.some((s) => s.youth.includes('Emma') && /already notified/.test(s.reason)));
  // clean up open sign-ins for later tests
  for (const youth of [emma, frank]) {
    await req('POST', '/api/admin/close-open', { cookie: adminCookie, body: { person_id: youth.id } });
  }
});

// ---------------------------------------------------------------- reports ----
test('report summary + CSVs honor date-range/person/event filters', async () => {
  const sum = await req('GET', '/api/admin/report/summary', { cookie: adminCookie });
  assert.ok(sum.json.length >= 1);
  const danny = sum.json.find((r) => r.first_name === 'Danny');
  assert.ok(danny.events_attended >= 1);
  // person filter
  const one = await req('GET', `/api/admin/report/summary?person_id=${person('Danny').id}`, { cookie: adminCookie });
  assert.equal(one.json.length, 1);
  // a range far in the past is empty (3-year lookback works, there's just nothing there)
  const old = await req('GET', '/api/admin/report/summary?from=2020-01-01&to=2020-12-31', { cookie: adminCookie });
  assert.equal(old.json.length, 0);
  const csv = await req('GET', `/api/admin/export/attendance.csv?person_id=${person('Danny').id}`, { cookie: adminCookie });
  assert.match(csv.text.split('\r\n')[0], /^event,last_name/);
  assert.ok(csv.text.includes('Danny'));
  assert.ok(!csv.text.includes('Emma'));
  const sumCsv = await req('GET', '/api/admin/export/summary.csv', { cookie: adminCookie });
  assert.match(sumCsv.text.split('\r\n')[0], /^last_name,first_name,type/);
});

// ----------------------------------------------------------------- photos ----
test('photo upload, session-gated serving, and removal', async () => {
  const danny = person('Danny');
  const form = new FormData();
  form.append('photo', new Blob([Buffer.from(PNG_1x1_B64, 'base64')], { type: 'image/png' }), 'danny.png');
  const up = await req('POST', `/api/admin/people/${danny.id}/photo`, { form, cookie: adminCookie });
  assert.equal(up.status, 200);
  assert.equal(up.json.photo_path, `${danny.id}.png`);
  // served with a session, blocked without
  const img = await fetch(`${base}/photos/${danny.id}.png`, { headers: { cookie: doorCookie } });
  assert.equal(img.status, 200);
  const anon = await fetch(`${base}/photos/${danny.id}.png`);
  assert.equal(anon.status, 401);
  // kiosk person view carries it
  const s = await req('GET', '/api/search?q=danny', { cookie: doorCookie });
  assert.equal(s.json[0].photo_path, `${danny.id}.png`);
  const del = await req('DELETE', `/api/admin/people/${danny.id}/photo`, { cookie: adminCookie });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${base}/photos/${danny.id}.png`, { headers: { cookie: doorCookie } })).status, 404);
});
