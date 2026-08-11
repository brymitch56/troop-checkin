'use strict';
// TLC attendance write-back (lib/attendanceSync + docs/12-attendance-writeback.md).
// Unit coverage for UID parsing, user-list fragment parsing, and name
// matching, plus the full push flow against a MOCK TLC server that
// reproduces the captured behaviour: Yii2 login with CSRF, POST
// /calendar/attendance-user-list returning an HTML fragment, and POST
// /calendar/toggle-attendance answering an EMPTY 200. No real network,
// no real credentials, synthetic people only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tlca-'));
process.env.CRED_KEY = require('crypto').randomBytes(32).toString('hex');

require('../server/migrate');
const { db } = require('../server/db');
const A = require('../server/lib/attendanceSync');
const rosterSync = require('../server/lib/rosterSync');

const EMAIL = 'fake-troopmaster@example.com';
const PASSWORD = 'fake-password-never-real';
const TOKEN = 'MockCsrf' + 'A'.repeat(40);
const EV = 'evtesthashid'; // 12 chars, like the real hashids
const UID_OK = `feed163264ab00cd-${EV}-tail1516aa17bcd`;

// ------------------------------------------------------------ fixtures -----
function mkPerson(first, last, extra = {}) {
  const r = db.prepare(
    `INSERT INTO person (first_name, last_name, is_youth, status, nickname, tlc_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`)
    .run(first, last, extra.is_youth ?? 1, extra.status || 'active',
         extra.nickname || null, extra.tlc_user_id || null);
  return Number(r.lastInsertRowid);
}
let evN = 0; // unique start_at per fixture — event has UNIQUE(ical_uid, start_at)
function mkEvent(extra = {}) {
  const start = new Date(Date.UTC(2026, 7, 10, 22, 30 + ++evN)).toISOString();
  const r = db.prepare(
    `INSERT INTO event (source, ical_uid, title, start_at, end_at, tlc_push, tlc_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(extra.source || 'ical', extra.ical_uid ?? UID_OK, extra.title || 'Weekly Meeting',
         start, '2026-08-11T23:59:00.000Z',
         extra.tlc_push ?? null, extra.tlc_event_id || null);
  return Number(r.lastInsertRowid);
}
const rowFor = (eventId, personId) => db.prepare(
  'SELECT * FROM tlc_attendance_push WHERE event_id = ? AND person_id = ?').get(eventId, personId);

// The captured fragment shape: profile anchor rows + checkbox-x inputs
// (id="<userHash>-<eventHash>-attended"). Attribute order matches the site.
function userListHtml(users, eventHash = EV) {
  return users.map((u) => `
    <div style="x" data-user="${u.hash}" class="user-row">
      <img src="/i.png" class="img-circle" alt="">
      <a href="/profile/${u.hash}?tab=advancement" target="_blank" data-pjax="0">${u.name}</a>
    </div>
    <div style="x"><div class="cbx-container"><div class="cbx cbx-md" tabindex="1000"><span class="cbx-icon"></span></div>
      <input type="text" id="${u.hash}-${eventHash}-attended" class="cbx-hide" name="attended-1" value="${u.attended}" data-krajee-checkboxx="1"></div></div>`).join('\n');
}

// ------------------------------------------------------- mock TLC server ---
function makeMockTlc(opts = {}) {
  const state = { loginPosts: 0, listPosts: 0, toggles: [], users: opts.users || [], rejectLogin: !!opts.rejectLogin };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['_csrf-frontend=cookietok; Path=/; HttpOnly'] });
        return res.end(`<html><head><meta name="csrf-token" content="${TOKEN}"></head>
          <body><form><input type="hidden" name="_csrf" value="${TOKEN}">
          <input name="LoginForm[email]"><input name="LoginForm[password]" type="password"></form></body></html>`);
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        state.loginPosts++;
        const p = new URLSearchParams(body);
        if (state.rejectLogin || p.get('LoginForm[email]') !== EMAIL || p.get('LoginForm[password]') !== PASSWORD) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html><body><form><input name="LoginForm[password]" type="password"></form></body></html>');
        }
        res.writeHead(302, { Location: '/dashboard', 'Set-Cookie': ['MOCKSESS=ok; Path=/; HttpOnly'] });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/dashboard') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<html><head><meta name="csrf-token" content="${TOKEN}"></head><body>Hello</body></html>`);
      }
      const authed = /MOCKSESS=ok/.test(req.headers.cookie || '');
      const csrfOk = req.headers['x-csrf-token'] === TOKEN &&
                     req.headers['x-requested-with'] === 'XMLHttpRequest';
      if (req.method === 'POST' && url.pathname === '/calendar/attendance-user-list') {
        state.listPosts++;
        if (!authed || !csrfOk) { res.writeHead(403); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(userListHtml(state.users, new URLSearchParams(body).get('eventId')));
      }
      if (req.method === 'POST' && url.pathname === '/calendar/toggle-attendance') {
        if (!authed || !csrfOk) { res.writeHead(403); return res.end(); }
        const p = new URLSearchParams(body);
        state.toggles.push({ userId: p.get('userId'), eventId: p.get('eventId'),
          value: p.get('value'), use_lesson_plans: p.get('use_lesson_plans') });
        const u = state.users.find((x) => x.hash === p.get('userId'));
        if (u) u.attended = p.get('value');
        res.writeHead(200, { 'Content-Type': 'text/html' }); // empty 200 = success (captured)
        return res.end('');
      }
      res.writeHead(404); res.end();
    });
  });
  return { server, state };
}

let mock, base;
before(async () => {
  mock = makeMockTlc();
  await new Promise((r) => { mock.server.listen(0, r); });
  base = `http://127.0.0.1:${mock.server.address().port}`;
  rosterSync.saveTlcCredentials({ email: EMAIL, password: PASSWORD });
});
after(() => mock.server.close());

const pushEnv = () => ({ ...process.env, TLC_BASE: base });

// ------------------------------------------------------------ unit: uid ----
test('tlcEventIdFromUid: middle segment of a TLC feed UID, null otherwise', () => {
  assert.equal(A.tlcEventIdFromUid(UID_OK), EV);
  assert.equal(A.tlcEventIdFromUid('not-a-tlc-uid'), null);
  assert.equal(A.tlcEventIdFromUid('caldav-3f2a9@google.com'), null);
  assert.equal(A.tlcEventIdFromUid(''), null);
  assert.equal(A.tlcEventIdFromUid(null), null);
});

test('resolveTlcEventId: parses + caches for ical, leaves manual events alone', () => {
  const evId = mkEvent();
  const ev = db.prepare('SELECT * FROM event WHERE id = ?').get(evId);
  assert.equal(A.resolveTlcEventId(ev), EV);
  assert.equal(db.prepare('SELECT tlc_event_id FROM event WHERE id = ?').get(evId).tlc_event_id, EV);
  const manual = mkEvent({ source: 'manual', ical_uid: null });
  assert.equal(A.resolveTlcEventId(db.prepare('SELECT * FROM event WHERE id = ?').get(manual)), null);
});

// ----------------------------------------------------- unit: list parse ----
test('parseUserList: hashids, names, and attended state from the fragment', () => {
  const html = userListHtml([
    { hash: 'aaaabbbbcccc', name: 'Andrews, Ben', attended: '' },
    { hash: 'ddddeeeeffff', name: 'Baxter, Bram', attended: '1' },
    { hash: 'gggghhhhiiii', name: 'Smith, John', attended: '0' },
    { hash: 'jjjjkkkkllll', name: 'Smith, John', attended: '0' }, // ambiguous name
  ]);
  const list = A.parseUserList(html, EV);
  assert.equal(list.byHash.get('aaaabbbbcccc').attended, 0);
  assert.equal(list.byHash.get('ddddeeeeffff').attended, 1);
  assert.equal(list.byName.get(A.nameKey('Andrews', 'Ben')), 'aaaabbbbcccc');
  assert.equal(list.byName.get(A.nameKey('Smith', 'John')), 'AMBIGUOUS');
});

test('matchPerson: cached id, exact name, nickname fallback, explicit failures', () => {
  const list = A.parseUserList(userListHtml([
    { hash: 'aaaabbbbcccc', name: 'Andrews, Ben', attended: '' },
    { hash: 'ddddeeeeffff', name: 'Baxter, Bram', attended: '' },
    { hash: 'gggghhhhiiii', name: 'Smith, John', attended: '' },
    { hash: 'jjjjkkkkllll', name: 'Smith, John', attended: '' },
  ]), EV);
  assert.equal(A.matchPerson({ first_name: 'X', last_name: 'Y', tlc_user_id: 'ddddeeeeffff' }, list).hash, 'ddddeeeeffff');
  assert.equal(A.matchPerson({ first_name: 'Ben', last_name: 'Andrews' }, list).hash, 'aaaabbbbcccc');
  assert.equal(A.matchPerson({ first_name: 'B-e-n', last_name: 'ANDREWS ' }, list).hash, 'aaaabbbbcccc'); // normalization
  assert.equal(A.matchPerson({ first_name: 'Abraham', last_name: 'Baxter', nickname: 'Bram' }, list).hash, 'ddddeeeeffff');
  assert.match(A.matchPerson({ first_name: 'John', last_name: 'Smith' }, list).error, /More than one/);
  assert.match(A.matchPerson({ first_name: 'Zed', last_name: 'Nowhere' }, list).error, /No TLC roster entry/);
});

// -------------------------------------------------------- unit: enqueue ----
test('enqueue: off by default; global switch; per-event override; visitor skip; dedupe', () => {
  const p1 = mkPerson('Alice', 'Alpha');
  const visitor = mkPerson('Vic', 'Visitor', { status: 'visitor' });
  const ev = mkEvent();

  assert.equal(A.enqueue(ev, [p1]).queued, 0); // disabled by default

  A.saveSettings({ enabled: 1 });
  assert.equal(A.enqueue(ev, [p1, visitor]).queued, 1); // visitor skipped
  assert.equal(A.enqueue(ev, [p1]).queued, 0);          // dedupe
  assert.equal(rowFor(ev, p1).use_lesson_plans, 1);     // frozen from settings

  const evNever = mkEvent({ tlc_push: 0 });
  assert.equal(A.enqueue(evNever, [p1]).queued, 0);

  const manual = mkEvent({ source: 'manual', ical_uid: null });
  assert.match(A.enqueue(manual, [p1]).reason, /no TLC link/);

  A.saveSettings({ enabled: 0 });
  const evAlways = mkEvent({ tlc_push: 1 });
  assert.equal(A.enqueue(evAlways, [p1]).queued, 1); // override beats global off
});

// ------------------------------------------------------------ push flow ----
test('runPush: marks attendees, learns hashids, skips already-attended, records failures', async () => {
  db.prepare('DELETE FROM tlc_attendance_push').run(); // isolate from enqueue tests
  const ben = mkPerson('Ben', 'Andrews');
  const bray = mkPerson('Bram', 'Baxter');
  const ghost = mkPerson('Zed', 'Nowhere');
  const ev = mkEvent();
  mock.state.users = [
    { hash: 'aaaabbbbcccc', name: 'Andrews, Ben', attended: '' },
    { hash: 'ddddeeeeffff', name: 'Baxter, Bram', attended: '1' }, // pre-marked on TLC
  ];

  A.saveSettings({ enabled: 1, use_lesson_plans: 1 });
  assert.equal(A.enqueue(ev, [ben, bray, ghost]).queued, 3);

  const r = await A.runPush({ env: pushEnv() });
  assert.deepEqual(r, { sent: 1, already: 1, failed: 1 });

  // exactly ONE toggle hit the wire, with the captured parameter set
  assert.deepEqual(mock.state.toggles, [
    { userId: 'aaaabbbbcccc', eventId: EV, value: '1', use_lesson_plans: '1' },
  ]);
  assert.equal(mock.state.listPosts, 1); // one user-list fetch per event

  assert.equal(rowFor(ev, ben).status, 'sent');
  assert.equal(rowFor(ev, bray).status, 'sent');
  assert.match(rowFor(ev, bray).detail, /already marked/);
  assert.equal(rowFor(ev, ghost).status, 'failed');
  assert.match(rowFor(ev, ghost).detail, /No TLC roster entry/);

  // learned hashids are cached on person for next time
  assert.equal(db.prepare('SELECT tlc_user_id FROM person WHERE id = ?').get(ben).tlc_user_id, 'aaaabbbbcccc');

  // idempotent: nothing pending → the next sweep is a no-op (no new logins)
  const logins = mock.state.loginPosts;
  const again = await A.runPush({ env: pushEnv() });
  assert.equal(again.skipped, true);
  assert.equal(mock.state.loginPosts, logins);

  // retryFailed re-queues only the failure
  assert.equal(A.retryFailed().retried, 1);
  assert.equal(rowFor(ev, ghost).status, 'pending');
  db.prepare('DELETE FROM tlc_attendance_push').run();
});

test('runPush: rejected login latches the sweep off; manual push bypasses; re-saving credentials clears it', async () => {
  const p = mkPerson('Carl', 'Charlie');
  const ev = mkEvent();
  A.saveSettings({ enabled: 1 });
  assert.equal(A.enqueue(ev, [p]).queued, 1);

  mock.state.rejectLogin = true;
  const r = await A.runPush({ env: pushEnv() });
  assert.equal(r.failed_login, true);
  assert.equal(r.auth_latched, true);
  assert.ok(A.getState().auth_failed_at);
  assert.equal(rowFor(ev, p).status, 'pending'); // row untouched — retried after fix

  // latched: the scheduled sweep refuses to try again…
  const sweep = await A.runPush({ env: pushEnv() });
  assert.match(sweep.reason, /Paused after a failed TLC login/);

  // …but a human "Push now" may, and success clears the queue
  mock.state.rejectLogin = false;
  mock.state.users = [{ hash: 'mmmmnnnnoooo', name: 'Charlie, Carl', attended: '' }];
  const manual = await A.runPush({ manual: true, env: pushEnv() });
  assert.equal(manual.sent, 1);
  assert.equal(A.getState().auth_failed_at, null); // success un-latches automatically
  db.prepare('DELETE FROM tlc_attendance_push').run();
});

// ------------------------------------------------- HTTP: routes + hook -----
const auth = require('../server/auth');
let server, base2, adminCookie, doorCookie;

test('HTTP: admin settings/status routes, event override, sign-in enqueues', async (t) => {
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin T', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door T', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base2 = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const req = async (method, url, { body, cookie } = {}) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
    const res = await fetch(base2 + url, { method, headers, body: body && JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
  };
  const staff = (await req('GET', '/api/staff-list')).json;
  adminCookie = (await req('POST', '/api/login', { body: { staff_id: staff.find((s) => s.role === 'admin').id, pin: 'adminpass' } })).setCookie.split(';')[0];
  doorCookie = (await req('POST', '/api/login', { body: { staff_id: staff.find((s) => s.role === 'door').id, pin: '1234' } })).setCookie.split(';')[0];

  // settings round-trip (admin only)
  assert.equal((await req('GET', '/api/admin/tlc-attendance', { cookie: doorCookie })).status, 403);
  A.saveSettings({ enabled: 0, use_lesson_plans: 1 });
  const put = await req('PUT', '/api/admin/tlc-attendance/settings',
    { body: { enabled: true, use_lesson_plans: false }, cookie: adminCookie });
  assert.deepEqual(put.json.settings, { enabled: 1, use_lesson_plans: 0 });
  const got = await req('GET', '/api/admin/tlc-attendance', { cookie: adminCookie });
  assert.equal(got.json.settings.enabled, 1);
  assert.equal(got.json.credentials_configured, true);

  // per-event override through PATCH /events/:id
  const ev = mkEvent();
  const patched = await req('PATCH', `/api/admin/events/${ev}`, { body: { tlc_push: 0 }, cookie: adminCookie });
  assert.equal(patched.json.tlc_push, 0);
  assert.equal((await req('PATCH', `/api/admin/events/${ev}`, { body: { tlc_push: null }, cookie: adminCookie })).json.tlc_push, null);

  // events list resolves + reports the TLC link
  const list = await req('GET', '/api/admin/events?include_past=1', { cookie: adminCookie });
  assert.equal(list.json.find((e) => e.id === ev).tlc_event_id, EV);

  // a kiosk sign-in enqueues a push row (settings enabled above)
  const adult = mkPerson('Ann', 'Adult', { is_youth: 0 });
  db.prepare('UPDATE event SET track_adults = 1 WHERE id = ?').run(ev);
  const txn = await req('POST', '/api/txn', {
    cookie: doorCookie,
    body: { client_uuid: 'tlca-uuid-1', direction: 'in', event_id: ev, entries: [{ person_id: adult }] },
  });
  assert.equal(txn.status, 200);
  assert.equal(rowFor(ev, adult).status, 'pending');
  assert.equal(rowFor(ev, adult).use_lesson_plans, 0); // frozen from the PUT above
});
