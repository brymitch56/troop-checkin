'use strict';
// End-to-end API tests: auth, roster import over HTTP, badge, visitor,
// events, and the /txn business rules. Runs against a real server on an
// ephemeral port with an isolated temp DATA_DIR.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-'));

const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const auth = require('../server/auth');
const { db, SIG_DIR } = require('../server/db');

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server, base, doorCookie, adminCookie;
let uuidN = 0;
const uuid = () => `test-uuid-${++uuidN}`;

async function req(method, url, { body, cookie, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) { payload = form; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

const person = (firstName) =>
  db.prepare('SELECT * FROM person WHERE first_name = ?').get(firstName);

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door Tester', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin Tester', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

// ------------------------------------------------------------------ auth ----
test('auth: staff list, wrong PIN rejected, login sets session cookie', async () => {
  const list = await req('GET', '/api/staff-list');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((s) => s.role).sort(), ['admin', 'door']);
  const doorId = list.json.find((s) => s.role === 'door').id;
  const adminId = list.json.find((s) => s.role === 'admin').id;

  const bad = await req('POST', '/api/login', { body: { staff_id: doorId, pin: '9999' } });
  assert.equal(bad.status, 401);

  const ok = await req('POST', '/api/login', { body: { staff_id: doorId, pin: '1234' } });
  assert.equal(ok.status, 200);
  doorCookie = ok.setCookie.split(';')[0];
  const admin = await req('POST', '/api/login', { body: { staff_id: adminId, pin: 'adminpass' } });
  adminCookie = admin.setCookie.split(';')[0];

  const me = await req('GET', '/api/me', { cookie: doorCookie });
  assert.equal(me.json.role, 'door');
});

test('auth: protected routes reject anonymous; admin route rejects door role', async () => {
  assert.equal((await req('GET', '/api/search?q=an')).status, 401);
  const form = new FormData();
  form.append('file', new Blob([buildWorkbookBuffer()]), 'roster.xlsx');
  const asDoor = await req('POST', '/api/roster/import', { form, cookie: doorCookie });
  assert.equal(asDoor.status, 403);
});

// -------------------------------------------------------- roster over HTTP ----
test('roster import: preview then commit (multer 2 multipart path)', async () => {
  let form = new FormData();
  form.append('file', new Blob([buildWorkbookBuffer()]), 'roster.xlsx');
  const prev = await req('POST', '/api/roster/import', { form, cookie: adminCookie });
  assert.equal(prev.status, 200);
  assert.equal(prev.json.mode, 'preview');
  assert.equal(prev.json.total, 6);
  assert.equal(prev.json.added.length, 6);

  form = new FormData();
  form.append('file', new Blob([buildWorkbookBuffer()]), 'roster.xlsx');
  const commit = await req('POST', '/api/roster/import?mode=commit', { form, cookie: adminCookie });
  assert.equal(commit.status, 200);
  assert.equal(commit.json.added, 6);
  assert.equal(commit.json.linked_guardians, 3);
});

// ------------------------------------------------------------------ people ----
test('search and guardians', async () => {
  const s = await req('GET', '/api/search?q=anders', { cookie: doorCookie });
  assert.deepEqual(s.json.map((p) => p.first_name).sort(), ['Alice', 'Danny']);
  const g = await req('GET', `/api/person/${person('Danny').id}/guardians`, { cookie: doorCookie });
  assert.deepEqual(g.json.map((x) => x.first_name), ['Alice']);
});

test('badge: link, exact lookup, reprint falls back to member id', async () => {
  const danny = person('Danny');
  const code = 'Y-2001 | tok-abc123';
  const link = await req('POST', '/api/badge/link', { body: { person_id: danny.id, code }, cookie: doorCookie });
  assert.equal(link.status, 200);
  const exact = await req('GET', `/api/badge/${encodeURIComponent(code)}`, { cookie: doorCookie });
  assert.equal(exact.json.match, 'badge');
  // reprinted badge: same member id, new token
  const reprint = await req('GET', `/api/badge/${encodeURIComponent('Y-2001 | tok-NEW')}`, { cookie: doorCookie });
  assert.equal(reprint.json.match, 'member');
  assert.equal(reprint.json.person.id, danny.id);
  const none = await req('GET', '/api/badge/ZZZ-404', { cookie: doorCookie });
  assert.equal(none.json.match, 'none');
  // linking the same code to someone else conflicts
  const clash = await req('POST', '/api/badge/link', { body: { person_id: person('Emma').id, code }, cookie: doorCookie });
  assert.equal(clash.status, 409);
});

test('visitor quick-add creates youth + guardian link; full contact set required', async () => {
  // youth visitors need ALL of: guardian name, phone, email
  const missing = await req('POST', '/api/visitor', {
    cookie: doorCookie,
    body: { first_name: 'Gabe', last_name: 'Visitor', is_youth: true, guardian_name: 'Gina Visitor', guardian_phone: '555-0301' },
  });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /email/i);
  const badEmail = await req('POST', '/api/visitor', {
    cookie: doorCookie,
    body: { first_name: 'Gabe', last_name: 'Visitor', is_youth: true, guardian_name: 'Gina Visitor', guardian_phone: '555-0301', guardian_email: 'not-an-email' },
  });
  assert.equal(badEmail.status, 400);

  const r = await req('POST', '/api/visitor', {
    cookie: doorCookie,
    body: { first_name: 'Gabe', last_name: 'Visitor', is_youth: true, guardian_name: 'Gina Visitor', guardian_phone: '555-0301', guardian_email: 'gina@example.com' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.person.status, 'visitor');
  const g = await req('GET', `/api/person/${r.json.person.id}/guardians`, { cookie: doorCookie });
  assert.deepEqual(g.json.map((x) => `${x.first_name} ${x.last_name}`), ['Gina Visitor']);
  // the email landed on the guardian record
  const gid = g.json[0].id;
  assert.equal(db.prepare('SELECT email FROM person WHERE id = ?').get(gid).email, 'gina@example.com');

  // adult visitors still need a name only
  const adult = await req('POST', '/api/visitor', {
    cookie: doorCookie, body: { first_name: 'Al', last_name: 'Adultguest', is_youth: false },
  });
  assert.equal(adult.status, 200);
});

// ------------------------------------------------------------------ events ----
let eventId;
test('events: create manual event, appears in current window', async () => {
  const now = Date.now();
  const ev = await req('POST', '/api/events', {
    cookie: doorCookie,
    body: {
      title: 'Test Meeting',
      start_at: new Date(now - 3600e3).toISOString(),
      end_at: new Date(now + 3600e3).toISOString(),
      track_adults: true,
    },
  });
  assert.equal(ev.status, 200);
  assert.equal(ev.json.track_adults, 1);
  eventId = ev.json.id;
  const cur = await req('GET', '/api/events/current', { cookie: doorCookie });
  assert.ok(cur.json.matching.some((e) => e.id === eventId));
});

// -------------------------------------------------------------------- txns ----
test('txn: youth sign-in requires signer and signature', async () => {
  const danny = person('Danny');
  const base = { client_uuid: uuid(), direction: 'in', event_id: eventId, entries: [{ person_id: danny.id }] };
  const noSigner = await req('POST', '/api/txn', { cookie: doorCookie, body: base });
  assert.equal(noSigner.status, 400);
  assert.match(noSigner.json.error, /signing/);
  const noSig = await req('POST', '/api/txn', {
    cookie: doorCookie, body: { ...base, client_uuid: uuid(), signer_person_id: person('Alice').id },
  });
  assert.equal(noSig.status, 400);
  assert.match(noSig.json.error, /Signature/);
});

test('txn: unauthorized signer rejected unless forced', async () => {
  const danny = person('Danny');
  const carol = person('Carol'); // not Danny's guardian
  const body = {
    client_uuid: uuid(), direction: 'in', event_id: eventId,
    entries: [{ person_id: danny.id }], signer_person_id: carol.id, signature_data: PNG_1x1,
  };
  const r = await req('POST', '/api/txn', { cookie: doorCookie, body });
  assert.equal(r.status, 422);
  assert.deepEqual(r.json.unauthorized, ['Danny Anderson']);
  const forced = await req('POST', '/api/txn', { cookie: doorCookie, body: { ...body, client_uuid: uuid(), force: true } });
  assert.equal(forced.status, 200);
  // clean up: sign Danny back out for the next tests
  const out = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: uuid(), direction: 'out', entries: [{ person_id: danny.id }], signer_person_id: person('Alice').id, signature_data: PNG_1x1 },
  });
  assert.equal(out.status, 200);
});

test('txn: sign-in writes signature, snapshots emergency phone, dedups client_uuid', async () => {
  const danny = person('Danny');
  const cu = uuid();
  const body = {
    client_uuid: cu, direction: 'in', event_id: eventId,
    entries: [{ person_id: danny.id, emerg_phone_1: '555-0999' }],
    signer_person_id: person('Alice').id, signature_data: PNG_1x1,
  };
  const r = await req('POST', '/api/txn', { cookie: doorCookie, body });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(SIG_DIR, `${cu}.png`)));
  assert.equal(person('Danny').last_emerg_phone_1, '555-0999');

  const dup = await req('POST', '/api/txn', { cookie: doorCookie, body });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.deduped, true);
  assert.equal(dup.json.txn_id, r.json.txn_id);

  const again = await req('POST', '/api/txn', { cookie: doorCookie, body: { ...body, client_uuid: uuid() } });
  assert.equal(again.status, 409); // already signed in
  assert.deepEqual(again.json.conflicts, ['Danny Anderson']);
});

test('txn: onsite reflects open state; sign-out closes it', async () => {
  const danny = person('Danny');
  const onsite = await req('GET', '/api/onsite', { cookie: doorCookie });
  assert.deepEqual(onsite.json.map((p) => p.first_name), ['Danny']);
  const filtered = await req('GET', '/api/onsite?patrol=Hawks', { cookie: doorCookie });
  assert.equal(filtered.json.length, 0);

  const emmaOut = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: uuid(), direction: 'out', entries: [{ person_id: person('Emma').id }], signer_person_id: person('Bob').id, signature_data: PNG_1x1 },
  });
  assert.equal(emmaOut.status, 409); // Emma was never signed in
  assert.match(emmaOut.json.error, /signed out/);

  const out = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: uuid(), direction: 'out', entries: [{ person_id: danny.id }], signer_person_id: person('Alice').id, signature_data: PNG_1x1 },
  });
  assert.equal(out.status, 200);
  const after = await req('GET', '/api/onsite', { cookie: doorCookie });
  assert.equal(after.json.length, 0);
});

test('txn: adult-only cart needs no signer or signature (event tracks adults)', async () => {
  const alice = person('Alice');
  const r = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: uuid(), direction: 'in', event_id: eventId, entries: [{ person_id: alice.id }] },
  });
  assert.equal(r.status, 200);
  const out = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: uuid(), direction: 'out', entries: [{ person_id: alice.id }] },
  });
  assert.equal(out.status, 200);
});

test('txn: adults rejected at events that do not track adults (FR-12)', async () => {
  const now = Date.now();
  const ev = await req('POST', '/api/events', {
    cookie: doorCookie,
    body: {
      title: 'Youth-only Meeting',
      start_at: new Date(now - 3600e3).toISOString(),
      end_at: new Date(now + 3600e3).toISOString(),
    },
  });
  assert.equal(ev.json.track_adults, 0);
  const r = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: uuid(), direction: 'in', event_id: ev.json.id, entries: [{ person_id: person('Carol').id }] },
  });
  assert.equal(r.status, 422);
  assert.deepEqual(r.json.adults, ['Carol Clark']);
});

test('txn: bad signature data rejected and no PNG orphaned', async () => {
  const sigsBefore = fs.readdirSync(SIG_DIR).length;
  const r = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: {
      client_uuid: uuid(), direction: 'in', event_id: eventId,
      entries: [{ person_id: person('Danny').id }],
      signer_person_id: person('Alice').id, signature_data: 'data:image/jpeg;base64,xxxx',
    },
  });
  assert.equal(r.status, 400);
  assert.equal(fs.readdirSync(SIG_DIR).length, sigsBefore);
});

test('patrols endpoint lists distinct active-youth patrols', async () => {
  const r = await req('GET', '/api/patrols', { cookie: doorCookie });
  assert.deepEqual(r.json, ['Eagles', 'Hawks']);
});
