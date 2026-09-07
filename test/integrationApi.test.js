'use strict';
// Integration API (docs/13-integration-api.md): API-key auth, the read-only
// endpoints, and the outbound webhook (signature, queue, backoff, hooks).
// SYNTHETIC DATA ONLY — invented names, placeholder ids.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-integ-'));
// credCrypto key from the environment so the webhook secret encrypts without
// touching a .env file (any 64-hex string is a valid key)
process.env.CRED_KEY = 'ab'.repeat(32);

const auth = require('../server/auth');
const { db } = require('../server/db');
const integrationAuth = require('../server/lib/integrationAuth');
const webhook = require('../server/lib/webhook');

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server, base, doorCookie, adminCookie, apiKey;
let youthA, youthB, adultC, visitorV, mergedM, inactiveI, guardian;
let evMeeting, evCampout, evPast, evManual;
let uuidN = 0;
const uuid = () => `integ-uuid-${++uuidN}`;

async function req(method, url, { body, cookie, bearer } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const api = (url, key = apiKey) => req('GET', url, { bearer: key });

const addPerson = (first, last, youth, extra = {}) => Number(db.prepare(
  `INSERT INTO person (is_youth, first_name, last_name, member_id, tlc_user_id, level, patrol, status,
                       phone_mobile, email, birthdate, merged_into_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(youth ? 1 : 0, first, last, extra.member_id || null, extra.tlc || null, extra.level || null,
    extra.patrol || null, extra.status || 'active', extra.phone || null, extra.email || null,
    extra.birthdate || null, extra.merged_into || null).lastInsertRowid);

const addEvent = (title, { uid = null, start, end, track_adults = 0, source = 'manual' } = {}) => Number(db.prepare(
  `INSERT INTO event (source, ical_uid, title, start_at, end_at, track_adults) VALUES (?, ?, ?, ?, ?, ?)`)
  .run(source, uid, title, start, end, track_adults).lastInsertRowid);

const isoShift = (h) => new Date(Date.now() + h * 3600_000).toISOString();

async function signIn(eventId, personIds, extra = {}) {
  const r = await req('POST', '/api/txn', { cookie: doorCookie, body: {
    client_uuid: uuid(), direction: 'in', event_id: eventId,
    entries: personIds.map((id) => ({ person_id: id })),
    signer_person_id: guardian, signature_data: PNG_1x1, allow_multi: true, ...extra,
  } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.txn_id;
}
async function signOut(eventId, personIds) {
  const r = await req('POST', '/api/txn', { cookie: doorCookie, body: {
    client_uuid: uuid(), direction: 'out', event_id: eventId,
    entries: personIds.map((id) => ({ person_id: id })),
    signer_person_id: guardian, signature_data: PNG_1x1,
  } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.txn_id;
}

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door T', 'door', ?)`).run(auth.hashSecret('1234'));
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin T', 'admin', ?)`).run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await req('GET', '/api/staff-list')).json;
  const login = async (role, pin) => (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staff.find((s) => s.role === role).id, pin }),
  })).headers.get('set-cookie').split(';')[0];
  doorCookie = await login('door', '1234');
  adminCookie = await login('admin', 'adminpass');

  guardian = addPerson('Gail', 'Andrews', false, { member_id: 'M-ADULT-1', phone: '555-0101', email: 'gail@example.com' });
  youthA = addPerson('Ben', 'Andrews', true, { member_id: 'M-YOUTH-1', tlc: 'hashA000001', level: 'Navigators', patrol: 'Falcons', birthdate: '2014-01-01' });
  youthB = addPerson('Bea', 'Andrews', true, { member_id: 'M-YOUTH-2', level: 'Navigators', patrol: 'Falcons' });
  adultC = addPerson('Carl', 'Andrews', false, { member_id: 'M-ADULT-2', tlc: 'hashC000003' });
  visitorV = addPerson('Vic', 'Visitor', true, { status: 'visitor' });
  inactiveI = addPerson('Ida', 'Inactive', true, { status: 'inactive', member_id: 'M-YOUTH-9' });
  // a duplicate record already merged INTO youthA — must resolve to youthA
  mergedM = addPerson('Ben', 'Andrews', true, { status: 'merged', merged_into: youthA });
  for (const y of [youthA, youthB, visitorV, inactiveI, mergedM]) {
    db.prepare(`INSERT INTO person_guardian (youth_id, guardian_id, authorized, is_primary) VALUES (?, ?, 1, 1)`).run(y, guardian);
  }
  db.prepare(`INSERT INTO person_guardian (youth_id, guardian_id, authorized) VALUES (?, ?, 1)`).run(adultC, guardian);

  evMeeting = addEvent('Weekly Meeting', { source: 'ical', uid: 'uid-meeting@example', start: isoShift(-1), end: isoShift(2) });
  evCampout = addEvent('Campout', { source: 'ical', uid: 'uid-campout@example', start: isoShift(-2), end: isoShift(30), track_adults: 1 });
  evPast = addEvent('Old Meeting', { source: 'ical', uid: 'uid-old@example', start: isoShift(-24 * 100), end: isoShift(-24 * 100 + 2) });
  evManual = addEvent('Service Project', { start: isoShift(24 * 10), end: isoShift(24 * 10 + 3) });
});

after(() => server && server.close());

// ------------------------------------------------------------------ auth ----
test('401 while disabled, with no key, with a missing header, and with a wrong key', async () => {
  assert.equal((await req('GET', '/api/integration/ping')).status, 401);
  assert.equal((await api('/api/integration/ping', 'tci_nope')).status, 401);
  // enabling requires a key first
  const noKey = await req('PUT', '/api/admin/integration/api', { cookie: adminCookie, body: { enabled: 1 } });
  assert.equal(noKey.status, 422);
  const gen = await req('POST', '/api/admin/integration/api/key', { cookie: adminCookie, body: { label: 'test consumer' } });
  assert.equal(gen.status, 200);
  assert.match(gen.json.key, /^tci_[A-Za-z0-9_-]{40,}$/);
  assert.equal(gen.json.api.key_set, true);
  assert.equal(gen.json.api.enabled, 0);
  apiKey = gen.json.key;
  // key exists but API still disabled → 401
  assert.equal((await api('/api/integration/ping')).status, 401);
  const on = await req('PUT', '/api/admin/integration/api', { cookie: adminCookie, body: { enabled: 1 } });
  assert.equal(on.json.api.enabled, 1);
  // wrong key counted, no oracle in the body
  const bad = await api('/api/integration/ping', 'tci_definitely-wrong');
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.json, { error: 'invalid api key' });
  assert.equal(integrationAuth.status().failed_count, 1);
  // stored settings never carry the plaintext
  const raw = db.prepare(`SELECT value FROM meta WHERE key = 'integration_api'`).get().value;
  assert.ok(!raw.includes(apiKey));
  assert.match(raw, /scrypt\$/);
});

test('ping answers with instance facts and no secrets', async () => {
  const r = await api('/api/integration/ping');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.app, 'troop-checkin');
  assert.equal(r.json.troop_id, 'NY-0000');
  assert.ok(r.json.tz && r.json.now);
  assert.equal(integrationAuth.status().last_ok_at !== null, true);
});

test('API key is accepted on no other route; cookies are not accepted here', async () => {
  assert.equal((await req('GET', '/api/admin/people', { bearer: apiKey })).status, 401);
  assert.equal((await req('GET', '/api/onsite', { bearer: apiKey })).status, 401);
  assert.equal((await req('GET', '/api/integration/ping', { cookie: adminCookie })).status, 401);
});

// ---------------------------------------------------------------- events ----
test('events: default window, manual events included, explicit range, bad dates', async () => {
  const dflt = await api('/api/integration/events');
  assert.equal(dflt.status, 200);
  const ids = dflt.json.map((e) => e.id);
  assert.ok(ids.includes(evMeeting) && ids.includes(evCampout) && ids.includes(evManual));
  assert.ok(!ids.includes(evPast)); // 100 days back is outside the default 30
  const manual = dflt.json.find((e) => e.id === evManual);
  assert.equal(manual.source, 'manual');
  assert.equal(manual.ical_uid, null);
  assert.deepEqual(Object.keys(manual).sort(), ['all_day', 'end_at', 'ical_uid', 'id', 'location', 'removed_from_feed',
    'requires_permission_form', 'source', 'start_at', 'title', 'tlc_event_id', 'track_adults'].sort());
  assert.ok(!('description' in manual)); // free text never leaves

  const day = (h) => new Date(Date.now() + h * 3600_000).toISOString().slice(0, 10);
  const old = await api(`/api/integration/events?from=${day(-24 * 101)}&to=${day(-24 * 99)}`);
  assert.deepEqual(old.json.map((e) => e.id), [evPast]);
  assert.equal((await api('/api/integration/events?from=yesterday')).status, 400);
});

// ------------------------------------------------------------ attendance ----
test('attendance: derived from txns, voids ignored, adults per track_adults, merged resolved, open flag', async () => {
  // meeting (youth only): A + B signed in; B signed out; visitor signed in; adult C refused at sign-in
  const inAB = await signIn(evMeeting, [youthA, youthB]);
  await signOut(evMeeting, [youthB]);
  await signIn(evMeeting, [visitorV]);
  // the merged duplicate's OLD id appears on a later txn row — resolves to A, once (earliest sign-in wins)
  db.prepare(`INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id) VALUES ('legacy-1', ?, 'in', ?, 1)`)
    .run(evMeeting, isoShift(0.25));
  const legacyId = db.prepare(`SELECT id FROM txn WHERE client_uuid = 'legacy-1'`).get().id;
  db.prepare(`INSERT INTO txn_person (txn_id, person_id, open) VALUES (?, ?, 1)`).run(legacyId, mergedM);

  let r = await api(`/api/integration/events/${evMeeting}/attendance`);
  assert.equal(r.status, 200);
  assert.equal(r.json.event.ical_uid, 'uid-meeting@example');
  assert.equal(r.json.event.track_adults, 0);
  const byId = Object.fromEntries(r.json.attendance.map((a) => [a.person_id, a]));
  assert.deepEqual(Object.keys(byId).map(Number).sort((a, b) => a - b), [youthA, youthB, visitorV].sort((a, b) => a - b));
  assert.equal(byId[youthA].open, 1);
  assert.equal(byId[youthA].signed_out_at, null);
  assert.equal(byId[youthA].sign_in_txn_id, inAB); // earliest sign-in wins over the later merged-id row
  assert.equal(byId[youthA].member_id, 'M-YOUTH-1');
  assert.equal(byId[youthA].tlc_user_id, 'hashA000001');
  assert.equal(byId[youthB].open, 0);
  assert.ok(byId[youthB].signed_out_at && byId[youthB].sign_out_txn_id);
  assert.equal(byId[visitorV].status, 'visitor');
  assert.equal(byId[visitorV].member_id, null);
  // PII stance: nothing beyond the contract
  for (const a of r.json.attendance) {
    for (const k of ['phone_mobile', 'email', 'birthdate', 'emerg_phone_1', 'signature_path', 'guardians', 'address']) {
      assert.ok(!(k in a), `${k} must not be exposed`);
    }
  }

  // voiding A's sign-in removes A (B keeps her own row — same txn, but void applies to the txn: both go)
  const v = await req('POST', `/api/admin/txns/${inAB}/void`, { cookie: adminCookie, body: {} });
  assert.equal(v.status, 200);
  r = await api(`/api/integration/events/${evMeeting}/attendance`);
  const after = Object.fromEntries(r.json.attendance.map((a) => [a.person_id, a]));
  // A falls back to the legacy (merged-id) sign-in, still open; B's sign-in was voided → gone
  assert.equal(after[youthA].sign_in_txn_id, legacyId);
  assert.equal(after[youthA].open, 1);
  assert.ok(!(youthB in after));
  assert.ok(visitorV in after);
  // the void MARKER txn itself never shows up as a sign-in
  assert.ok(!r.json.attendance.some((a) => a.sign_in_txn_id === v.json.void_txn_id));

  // campout tracks adults: C appears with is_youth 0
  await signIn(evCampout, [adultC]);
  r = await api(`/api/integration/events/${evCampout}/attendance`);
  const c = r.json.attendance.find((a) => a.person_id === adultC);
  assert.ok(c && c.is_youth === 0 && c.member_id === 'M-ADULT-2');

  // lookup by shared identity, exact and re-normalized timestamp; unknown → 404
  const ev = db.prepare('SELECT * FROM event WHERE id = ?').get(evCampout);
  const byUid = await api(`/api/integration/attendance?ical_uid=${encodeURIComponent(ev.ical_uid)}&start_at=${encodeURIComponent(ev.start_at)}`);
  assert.equal(byUid.status, 200);
  assert.equal(byUid.json.event.id, evCampout);
  const alt = new Date(ev.start_at).toISOString().replace('.000Z', 'Z');
  assert.equal((await api(`/api/integration/attendance?ical_uid=${encodeURIComponent(ev.ical_uid)}&start_at=${encodeURIComponent(alt)}`)).json.event.id, evCampout);
  assert.equal((await api('/api/integration/attendance?ical_uid=nope&start_at=2026-01-01T00:00:00Z')).status, 404);
  assert.equal((await api('/api/integration/attendance?ical_uid=nope')).status, 400);
  assert.equal((await api('/api/integration/events/999999/attendance')).status, 404);
});

// ---------------------------------------------------------------- people ----
test('people: active + visitors, youth and adults, merged/inactive excluded, no contact fields', async () => {
  const r = await api('/api/integration/people');
  assert.equal(r.status, 200);
  const ids = r.json.map((p) => p.id);
  assert.ok(ids.includes(youthA) && ids.includes(adultC) && ids.includes(visitorV) && ids.includes(guardian));
  assert.ok(!ids.includes(mergedM) && !ids.includes(inactiveI));
  const cols = Object.keys(r.json[0]).sort();
  assert.deepEqual(cols, ['first_name', 'id', 'is_youth', 'last_name', 'level', 'member_id', 'membership_expires',
    'nickname', 'patrol', 'status', 'tlc_user_id'].sort());
  for (const p of r.json) {
    for (const k of ['phone_mobile', 'phone_home', 'email', 'birthdate', 'photo_path', 'health_form_date', 'consent_form_id', 'badge_code']) {
      assert.ok(!(k in p), `${k} must not be exposed`);
    }
  }
});

// --------------------------------------------------------------- webhook ----
test('webhook signature: computed and verified per the documented scheme; stale timestamps rejected', () => {
  const body = '{"type":"test"}';
  const sig = webhook.sign('shared-secret-fake', '1700000000', body);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(webhook.verifySignature('shared-secret-fake', '1700000000', body, sig, 1700000100), true);
  assert.equal(webhook.verifySignature('shared-secret-fake', '1700000000', body, sig, 1700000000 + 301), false);
  assert.equal(webhook.verifySignature('other-secret', '1700000000', body, sig, 1700000100), false);
  assert.equal(webhook.verifySignature('shared-secret-fake', '1700000000', body + ' ', sig, 1700000100), false);
});

test('webhook settings: URL validated, secret encrypted at rest and never echoed, enabling needs both', async () => {
  const bad = await req('PUT', '/api/admin/integration/webhook', { cookie: adminCookie, body: { url: 'ftp://x' } });
  assert.equal(bad.status, 400);
  const early = await req('PUT', '/api/admin/integration/webhook', { cookie: adminCookie, body: { enabled: 1 } });
  assert.equal(early.status, 422);
  const ok = await req('PUT', '/api/admin/integration/webhook', { cookie: adminCookie, body: {
    url: 'http://127.0.0.1:9/hook', secret: 'fake-webhook-secret-never-real', events: ['txn.created', 'txn.voided', 'bogus'],
  } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.webhook, { enabled: 0, url: 'http://127.0.0.1:9/hook', secret_set: true, events: ['txn.created', 'txn.voided'] });
  const raw = db.prepare(`SELECT value FROM meta WHERE key = 'integration_webhook'`).get().value;
  assert.ok(!raw.includes('fake-webhook-secret-never-real'));
  assert.equal(webhook.secretPlain(), 'fake-webhook-secret-never-real');
  const status = await req('GET', '/api/admin/integration', { cookie: adminCookie });
  assert.equal(status.json.webhook.secret_set, true);
  assert.ok(!JSON.stringify(status.json).includes('fake-webhook-secret-never-real'));
  // nothing is queued while disabled
  await signIn(evCampout, [youthB]);
  assert.equal(webhook.queueSummary().pending, 0);
});

test('webhook delivery: sign-in unaffected when unreachable; retried with backoff; sent on 200; voids emit', async () => {
  const calls = [];
  let mode = 'throw';
  webhook.setTransport(async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: opts.body });
    if (mode === 'throw') throw new Error('connect ECONNREFUSED');
    if (mode === '500') return { status: 500 };
    return { status: 200 };
  });
  try {
    await req('PUT', '/api/admin/integration/webhook', { cookie: adminCookie, body: { enabled: 1 } });

    // 1. unreachable consumer: the kiosk still gets its 200; row queued
    const inId = await signIn(evMeeting, [youthB]);
    await new Promise((r) => setTimeout(r, 120)); // let the nudge sweep run
    let row = db.prepare(`SELECT * FROM webhook_delivery WHERE type = 'txn.created' ORDER BY id DESC LIMIT 1`).get();
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /ECONNREFUSED/);
    assert.ok(row.next_attempt_at > row.created_at); // backed off (+60s)
    const payload = JSON.parse(row.payload);
    assert.equal(payload.type, 'txn.created');
    assert.equal(payload.txn.id, inId);
    assert.equal(payload.txn.ical_uid, 'uid-meeting@example');
    assert.equal(payload.txn.direction, 'in');
    assert.deepEqual(payload.persons, [{ person_id: youthB, member_id: 'M-YOUTH-2', tlc_user_id: null, is_youth: 1 }]);
    assert.ok(!row.payload.includes('Andrews') && !row.payload.includes('555-')); // ids only

    // 2. not due yet → the sweep leaves it alone
    assert.deepEqual(await webhook.sweep(), { sent: 0, failed: 0 });
    // 3. force due, consumer answers 500 → attempt 2, next delay 5m
    db.prepare(`UPDATE webhook_delivery SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?`).run(row.id);
    mode = '500';
    assert.deepEqual(await webhook.sweep(), { sent: 0, failed: 1 });
    row = db.prepare('SELECT * FROM webhook_delivery WHERE id = ?').get(row.id);
    assert.equal(row.attempts, 2);
    assert.match(row.last_error, /HTTP 500/);
    // 4. consumer healthy → sent, with the documented headers and a valid signature
    db.prepare(`UPDATE webhook_delivery SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?`).run(row.id);
    mode = '200';
    assert.deepEqual(await webhook.sweep(), { sent: 1, failed: 0 });
    row = db.prepare('SELECT * FROM webhook_delivery WHERE id = ?').get(row.id);
    assert.equal(row.status, 'sent');
    assert.ok(row.sent_at);
    const last = calls[calls.length - 1];
    assert.equal(last.url, 'http://127.0.0.1:9/hook');
    assert.equal(last.headers['X-Troop-Checkin-Event'], 'txn.created');
    assert.equal(webhook.verifySignature('fake-webhook-secret-never-real', last.headers['X-Troop-Checkin-Timestamp'],
      last.body, last.headers['X-Troop-Checkin-Signature']), true);
    assert.equal(last.headers['Content-Type'], 'application/json');

    // 5. void → txn.voided with both ids, delivered by the nudge
    const v = await req('POST', `/api/admin/txns/${inId}/void`, { cookie: adminCookie, body: {} });
    await new Promise((r) => setTimeout(r, 120));
    const vrow = db.prepare(`SELECT * FROM webhook_delivery WHERE type = 'txn.voided' ORDER BY id DESC LIMIT 1`).get();
    assert.equal(vrow.status, 'sent');
    const vp = JSON.parse(vrow.payload);
    assert.equal(vp.voided_txn_id, inId);
    assert.equal(vp.voiding_txn_id, v.json.void_txn_id);
    assert.equal(vp.txn.voided_by_txn_id, v.json.void_txn_id);

    // 6. a late-replayed offline txn keeps its original signed_at in the payload
    const late = new Date(Date.now() - 5 * 3600_000).toISOString();
    const lateId = await signIn(evCampout, [youthA], { signed_at: late });
    await new Promise((r) => setTimeout(r, 120));
    const lrow = db.prepare(`SELECT payload FROM webhook_delivery WHERE type = 'txn.created' ORDER BY id DESC LIMIT 1`).get();
    assert.equal(JSON.parse(lrow.payload).txn.id, lateId);
    assert.equal(JSON.parse(lrow.payload).txn.signed_at, late);

    // 7. event filter: ical.synced is not subscribed → nothing queued
    assert.equal(webhook.emitIcalSynced({ added: 1 }), null);
    await req('PUT', '/api/admin/integration/webhook', { cookie: adminCookie, body: { events: webhook.ALL_EVENTS } });
    assert.ok(webhook.emitIcalSynced({ added: 1, updated: 2 }));
    await new Promise((r) => setTimeout(r, 120));
    const srow = db.prepare(`SELECT * FROM webhook_delivery WHERE type = 'ical.synced' ORDER BY id DESC LIMIT 1`).get();
    assert.deepEqual(JSON.parse(srow.payload).counts, { added: 1, updated: 2, flagged: 0, deleted: 0, feed_events: 0 });

    // 8. Send test event: synchronous result; a failing test row is marked failed, never retried;
    //    give-up after MAX_ATTEMPTS → failed; Retry failed re-queues non-test rows only
    mode = '200';
    const t = await req('POST', '/api/admin/integration/webhook/test', { cookie: adminCookie, body: {} });
    assert.equal(t.json.ok, true);
    mode = '500';
    const t2 = await req('POST', '/api/admin/integration/webhook/test', { cookie: adminCookie, body: {} });
    assert.equal(t2.json.ok, false);
    db.prepare(`UPDATE webhook_delivery SET status = 'failed', attempts = ? WHERE type = 'ical.synced'`).run(webhook.MAX_ATTEMPTS);
    const retry = await req('POST', '/api/admin/integration/webhook/retry', { cookie: adminCookie, body: {} });
    assert.equal(retry.json.retried, 1);
    assert.equal(db.prepare(`SELECT status FROM webhook_delivery WHERE id = ?`).get(t2.json.id).status, 'failed');
    // prune: old sent rows go, pending/failed stay
    db.prepare(`UPDATE webhook_delivery SET sent_at = datetime('now', '-40 days') WHERE status = 'sent'`).run();
    const pruned = webhook.prune(30);
    assert.ok(pruned >= 3);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM webhook_delivery WHERE status = 'sent'`).get().n, 0);
  } finally {
    webhook.setTransport(null);
    await req('PUT', '/api/admin/integration/webhook', { cookie: adminCookie, body: { enabled: 0 } });
  }
});

test('revoking the key returns 401 immediately; disabling does too', async () => {
  assert.equal((await api('/api/integration/ping')).status, 200);
  const rev = await req('DELETE', '/api/admin/integration/api/key', { cookie: adminCookie });
  assert.equal(rev.json.api.key_set, false);
  assert.equal((await api('/api/integration/ping')).status, 401);
  const gen = await req('POST', '/api/admin/integration/api/key', { cookie: adminCookie, body: {} });
  apiKey = gen.json.key;
  assert.equal((await api('/api/integration/ping')).status, 200); // still enabled, new key works
  await req('PUT', '/api/admin/integration/api', { cookie: adminCookie, body: { enabled: 0 } });
  assert.equal((await api('/api/integration/ping')).status, 401);
});
