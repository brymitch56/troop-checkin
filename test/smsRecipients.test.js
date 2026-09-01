'use strict';
// SMS recipient mode: 'primary' (one guardian, deterministic fallback) vs
// 'all' (every opted-in guardian), one text per guardian across youth,
// consent never widened, per-broadcast override, settings route.
// SYNTHETIC DATA ONLY. Twilio is not configured in tests, so sends are
// recorded as 'failed' rows — the grouping is what's asserted.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-smsr-'));

const auth = require('../server/auth');
const { db } = require('../server/db');
const ns = require('../server/lib/notifySweep');

let server, base, adminCookie, evId;
let kid1, kid2, mom, dad, aunt, noPhone;

const addPerson = (first, last, youth, extra = {}) => Number(db.prepare(
  `INSERT INTO person (is_youth, first_name, last_name, phone_mobile, status)
   VALUES (?, ?, ?, ?, 'active')`).run(youth ? 1 : 0, first, last, extra.phone || null).lastInsertRowid);
const link = (youth, adult, { primary = 0, opt = 'yes', authorized = 1, form = null } = {}) => db.prepare(
  `INSERT INTO person_guardian (youth_id, guardian_id, authorized, is_primary, source, sms_opt_in, consent_form_id)
   VALUES (?, ?, ?, ?, 'manual', ?, ?)`).run(youth, adult, authorized, primary, opt, form);

async function req(method, url, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin S', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await req('GET', '/api/staff-list')).json;
  adminCookie = (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staff[0].id, pin: 'adminpass' }),
  })).headers.get('set-cookie').split(';')[0];

  const formId = Number(db.prepare(`INSERT INTO consent_form (file_path, signed_by) VALUES ('f.pdf', 'Mia Family')`).run().lastInsertRowid);
  // family: two kids; mom (primary, opted in), dad (opted in), aunt (NOT opted in),
  // and a no-phone opted-in grandparent who can never be texted
  kid1 = addPerson('Kim', 'Family', true);
  kid2 = addPerson('Kai', 'Family', true);
  mom = addPerson('Mia', 'Family', false, { phone: '555-0401' });
  dad = addPerson('Dan', 'Family', false, { phone: '555-0402' });
  aunt = addPerson('Ann', 'Family', false, { phone: '555-0403' });
  noPhone = addPerson('Gus', 'Grand', false);
  for (const k of [kid1, kid2]) {
    link(k, mom, { primary: 1, form: formId });
    link(k, dad, { form: formId });
    link(k, aunt, { opt: 'unknown' });
    link(k, noPhone, { form: formId });
  }
  evId = Number(db.prepare(
    `INSERT INTO event (source, title, start_at, end_at) VALUES ('manual', 'Weekly Meeting', datetime('now','-2 hours'), datetime('now','-1 hour'))`
  ).run().lastInsertRowid);
});

after(() => server && server.close());

const rowsFor = (...kids) => kids.map((id) => {
  const p = db.prepare('SELECT * FROM person WHERE id = ?').get(id);
  return { person_id: id, first_name: p.first_name, last_name: p.last_name, nickname: null, event_id: evId, title: 'Weekly Meeting' };
});

test('eligibility is per adult: unknown links and no-mobile guardians never qualify; order is deterministic', () => {
  const ids = ns.eligibleGuardians(kid1).map((g) => g.guardian_id);
  assert.deepEqual(ids, [mom, dad]);           // primary first, then by name; aunt (unknown) + Gus (no phone) out
  assert.equal(ns.pickGuardian(kid1).guardian_id, mom);
  assert.deepEqual(ns.recipientsFor(kid1, 'all').map((g) => g.guardian_id), [mom, dad]);
  assert.deepEqual(ns.recipientsFor(kid1, 'primary').map((g) => g.guardian_id), [mom]);
});

test('primary mode falls back deterministically when the primary is ineligible', () => {
  db.prepare(`UPDATE person_guardian SET sms_opt_in = 'stop' WHERE youth_id = ? AND guardian_id = ?`).run(kid1, mom);
  assert.equal(ns.pickGuardian(kid1).guardian_id, dad);
  db.prepare(`UPDATE person_guardian SET sms_opt_in = 'yes' WHERE youth_id = ? AND guardian_id = ?`).run(kid1, mom);
});

test('default mode is primary: one text per family for two kids; broadcast reaches mom only', async () => {
  assert.equal(ns.getRecipientMode(), 'primary');
  const r = await ns.messageGuardians(rowsFor(kid1, kid2), 'Bus is late.');
  const contacted = r.sent.concat(r.skipped).filter((x) => x.guardian);
  assert.equal(contacted.length, 1);               // exactly one guardian message
  assert.equal(contacted[0].guardian, 'Mia Family');
  assert.equal(contacted[0].youths.length, 2);     // both kids in the one text
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM sms_message WHERE guardian_id = ?`).get(dad).c, 0);
});

test("'all' mode texts every opted-in guardian once each, still never the un-consented aunt", async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM sms_message').get().c;
  const r = await ns.messageGuardians(rowsFor(kid1, kid2), 'Pickup at 8:30.', { mode: 'all' });
  const contacted = r.sent.concat(r.skipped).filter((x) => x.guardian).map((x) => x.guardian).sort();
  assert.deepEqual(contacted, ['Dan Family', 'Mia Family']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sms_message').get().c, before + 2); // one per guardian, not per kid
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM sms_message WHERE guardian_id = ?`).get(aunt).c, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM sms_message WHERE guardian_id = ?`).get(noPhone).c, 0);
});

test("lingering alerts in 'all' mode: one notification row per (youth, guardian); dedupe per pair", async () => {
  ns.saveRecipientMode('all');
  const r1 = await ns.notifyLingering(rowsFor(kid1));
  assert.equal(r1.recorded, 2); // mom + dad each get a row for kid1
  const r2 = await ns.notifyLingering(rowsFor(kid1));
  assert.equal(r2.recorded, 0);
  assert.ok(r2.skipped.some((s) => /already notified/.test(s.reason)));
  ns.saveRecipientMode('primary');
});

test('settings route: default primary, PUT flips, /api/config carries it, admin-gated', async () => {
  assert.equal((await req('GET', '/api/admin/sms-recipients')).status, 401);
  assert.equal((await req('GET', '/api/admin/sms-recipients', { cookie: adminCookie })).json.mode, 'primary');
  assert.equal((await req('GET', '/api/config')).json.sms_recipients, 'primary');
  const put = await req('PUT', '/api/admin/sms-recipients', { cookie: adminCookie, body: { mode: 'all' } });
  assert.equal(put.json.mode, 'all');
  assert.equal((await req('GET', '/api/config')).json.sms_recipients, 'all');
  // junk values fall back to primary, never to something broader
  assert.equal((await req('PUT', '/api/admin/sms-recipients', { cookie: adminCookie, body: { mode: 'everyone' } })).json.mode, 'primary');
});

// ------------------------------------------------ consent signer check ----
const cc = require('../server/lib/consentCheck');

test('signerMatches: tolerant name match, blank signer never matches', () => {
  const p = { first_name: 'Mia', last_name: 'Family', nickname: null };
  assert.equal(cc.signerMatches('Mia Family', p), true);
  assert.equal(cc.signerMatches('  family, MIA  ', p), true);
  assert.equal(cc.signerMatches('Dan Family', p), false);   // other parent
  assert.equal(cc.signerMatches('', p), false);
  assert.equal(cc.signerMatches('Mia F.', p), false);       // last name required
  assert.equal(cc.signerMatches('Mimi Family', { ...p, nickname: 'Mimi' }), true);
});

test("opt-in on someone else's form: 422 signer_mismatch, then explicit confirm proceeds", async () => {
  // dad's link currently carries mom's form ("Mia Family" signed it) but is
  // already 'yes' from the fixture; exercise the PATCH path on the aunt
  const momForm = db.prepare(`SELECT consent_form_id AS id FROM person_guardian WHERE youth_id = ? AND guardian_id = ?`).get(kid1, mom).id;
  let r = await req('PATCH', `/api/admin/people/${kid1}/guardians/${aunt}`,
    { cookie: adminCookie, body: { sms_opt_in: 'yes', consent_form_id: momForm } });
  assert.equal(r.status, 422);
  assert.equal(r.json.signer_mismatch, true);
  assert.equal(r.json.signed_by, 'Mia Family');
  assert.equal(db.prepare(`SELECT sms_opt_in FROM person_guardian WHERE youth_id = ? AND guardian_id = ?`).get(kid1, aunt).sms_opt_in, 'unknown');
  // a form the aunt signed herself sails through
  const auntForm = Number(db.prepare(`INSERT INTO consent_form (file_path, signed_by) VALUES ('a.pdf', 'Ann Family')`).run().lastInsertRowid);
  r = await req('PATCH', `/api/admin/people/${kid1}/guardians/${aunt}`,
    { cookie: adminCookie, body: { sms_opt_in: 'yes', consent_form_id: auntForm } });
  assert.equal(r.status, 200);
  // explicit override is honored (admin asserts she signed something on paper)
  r = await req('PATCH', `/api/admin/people/${kid2}/guardians/${aunt}`,
    { cookie: adminCookie, body: { sms_opt_in: 'yes', consent_form_id: momForm, signer_confirmed: true } });
  assert.equal(r.status, 200);
  // adult self-consent path checks too
  r = await req('PATCH', `/api/admin/people/${dad}/opt-in`,
    { cookie: adminCookie, body: { sms_opt_in: 'yes', consent_form_id: momForm } });
  assert.equal(r.status, 422);
  assert.equal(r.json.signer_mismatch, true);
  // guardian-bulk path: existing adult on someone else's form
  r = await req('POST', '/api/admin/guardian-bulk',
    { cookie: adminCookie, body: { guardian_id: aunt, youth_ids: [kid1], opt_in: true, consent_form_id: momForm } });
  assert.equal(r.status, 422);
  assert.equal(r.json.signer_mismatch, true);
});

test('consent audit lists mismatched opt-ins (guardian links + adults) and the CSV exports them', async () => {
  const rows = (await req('GET', '/api/admin/consent-audit', { cookie: adminCookie })).json;
  // dad is opted in on mom's form (fixture) -> flagged for both kids; aunt on kid2 was force-confirmed -> flagged
  const dadRows = rows.filter((r) => r.guardian_name === 'Dan Family');
  assert.equal(dadRows.length, 2);
  assert.match(dadRows[0].reason, /does not match/);
  assert.ok(rows.some((r) => r.guardian_name === 'Ann Family' && r.youth_name === 'Kai Family'));
  assert.ok(!rows.some((r) => r.guardian_name === 'Mia Family'));      // her own form: clean
  assert.ok(!rows.some((r) => r.guardian_name === 'Ann Family' && r.youth_name === 'Kim Family')); // her own form: clean
  const csv = await fetch(base + '/api/admin/export/consent-audit.csv', { headers: { cookie: adminCookie } });
  const text = await csv.text();
  assert.match(text.split('\r\n')[0], /^kind,opted_in_adult,youth,form_signed_by/);
  assert.match(text, /Dan Family/);
});
