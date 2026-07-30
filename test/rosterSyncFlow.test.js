'use strict';
// Full roster-sync sequence against a MOCK Trail Life Connect server that
// reproduces the documented behaviour (docs/10-roster-sync.md): Yii2 login
// with CSRF, 503 on the first export GET, a poll endpoint that returns
// pending then finished, then the file — deliberately served with the WRONG
// content type, as observed on the real site. Also covers the pending-import
// staging, replacement, and the admin approve/discard endpoints over HTTP.
// No real network, no real credentials, synthetic people only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sync-'));
// pin a credential-encryption key so tests never write a real .env
process.env.CRED_KEY = require('crypto').randomBytes(32).toString('hex');

const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const F = require('../server/scripts/fetch-roster');
const auth = require('../server/auth');
const { db } = require('../server/db');

const EMAIL = 'fake-troopmaster@example.com';
const PASSWORD = 'fake-password-never-real';
const TOKEN = 'MockCsrf' + 'A'.repeat(80);

// ------------------------------------------------------- mock TLC server ---
function makeMockTlc(opts = {}) {
  const state = {
    polls: 0, ready: false, exportGets: 0, loginPosts: 0,
    pendingPolls: opts.pendingPolls ?? 2,
    fileBuf: opts.fileBuf || buildWorkbookBuffer(),
    serveHtmlExport: opts.serveHtmlExport || false,
  };
  const sessions = new Set();
  const getCookies = (req) => Object.fromEntries((req.headers.cookie || '')
    .split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookies = getCookies(req);
    const authed = sessions.has(cookies.MOCKSESS);

    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': ['_csrf-frontend=cookietok; Path=/; HttpOnly'],
      });
      return res.end(`<!doctype html><html><head>
        <meta name="csrf-token" content="${TOKEN}"></head><body>
        <form action="/login" method="post">
          <input type="hidden" name="_csrf" value="${TOKEN}">
          <input name="LoginForm[email]"><input name="LoginForm[password]" type="password">
        </form></body></html>`);
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      state.loginPosts++;
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const ok = p.get('_csrf') === TOKEN
          && p.get('LoginForm[email]') === EMAIL
          && p.get('LoginForm[password]') === PASSWORD;
        if (!ok) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(`<!doctype html><html><body>Invalid login.
            <form><input type="hidden" name="_csrf" value="${TOKEN}">
            <input name="LoginForm[password]" type="password"></form></body></html>`);
        }
        const sess = 'sess-' + Math.random().toString(36).slice(2);
        sessions.add(sess);
        // session cookie arrives ON THE 302 — the fetcher must absorb
        // cookies mid-redirect-chain for the rest of the flow to work
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': [`MOCKSESS=${sess}; Path=/; HttpOnly`],
        });
        res.end();
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (!authed) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><head>
        <meta name="csrf-token" content="${TOKEN}"></head><body>Signed in.</body></html>`);
    }

    if (req.method === 'GET' && url.pathname === '/user/index' && url.searchParams.has('export')) {
      if (!authed) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      state.exportGets++;
      if (!state.ready) { res.writeHead(503, { 'Content-Type': 'text/html' }); return res.end('preparing'); }
      if (state.serveHtmlExport) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><html><body>Please sign in.' + 'x'.repeat(600) + '</body></html>');
      }
      // the real server mislabels CSV as spreadsheetml — always send the
      // spreadsheetml type so the fetcher must sniff bytes, not headers
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      return res.end(state.fileBuf);
    }

    if (req.method === 'POST' && url.pathname === '/databuilder/get-download-status') {
      if (!authed || req.headers['x-csrf-token'] !== TOKEN
          || req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":"bad request"}');
      }
      state.polls++;
      if (state.polls > state.pendingPolls) state.ready = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: state.ready ? 'finished' : 'pending' }));
    }

    res.writeHead(404); res.end();
  });
  return { server, state };
}

const fetchEnv = (base, extra = {}) => ({
  DATA_DIR: process.env.DATA_DIR,
  TLC_BASE: base, TLC_EMAIL: EMAIL, TLC_PASSWORD: PASSWORD,
  TLC_POLL_MS: '5', TLC_POLL_MAX: '10',
  ...extra,
});

let mock, mockBase, app, appServer, appBase, adminCookie;

async function req(method, url, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(appBase + url, { method, headers, body: payload });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Sync Admin', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  app = require('../server/index');
  await new Promise((r) => { appServer = app.listen(0, r); });
  appBase = `http://127.0.0.1:${appServer.address().port}`;
  const staff = await fetch(appBase + '/api/staff-list').then((r) => r.json());
  const login = await req('POST', '/api/login',
    { body: { staff_id: staff[0].id, pin: 'adminpass' } });
  adminCookie = login.setCookie.split(';')[0];
});

after(() => { appServer && appServer.close(); mock && mock.server.close(); });

// ------------------------------------------------------------- the flow ----
test('full sequence: login → 503 kick-off → poll pending→finished → file → pending import staged', async () => {
  const m = makeMockTlc({ pendingPolls: 2 });
  mock = m;
  await new Promise((r) => m.server.listen(0, r));
  mockBase = `http://127.0.0.1:${m.server.address().port}`;

  const r = await F.runFetch(fetchEnv(mockBase));
  assert.equal(r.format, 'xlsx');
  assert.equal(r.rows, 7);            // synthetic: 6 people + junk row
  assert.equal(r.replaced, 0);        // first pending
  assert.ok(fs.existsSync(r.file));
  assert.match(path.dirname(r.file), /roster-exports$/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(r.file).mode & 0o777, 0o600); // PII file mode
  }
  assert.equal(m.state.exportGets, 2); // kick-off + download
  assert.equal(m.state.polls, 3);      // pending, pending, finished
  assert.equal(m.state.loginPosts, 1); // exactly one login attempt, no retry

  const state = F.readState(F.makeConfig(fetchEnv(mockBase)));
  assert.equal(state.last_status, 'ok');
  assert.equal(state.last_rows, 7);

  // the pending import is staged with a full preview (6 fake adds on empty DB)
  const pending = require('../server/lib/rosterSync').getPending();
  assert.ok(pending);
  assert.equal(pending.rows, 6);      // parsed people (junk row excluded)
  assert.equal(pending.preview.added.length, 6);
  assert.equal(pending.preview.deactivated.length, 0);
  assert.equal(pending.source, 'sync');
});

test('a second successful fetch REPLACES the pending import and reports it', async () => {
  const m = makeMockTlc({ pendingPolls: 0 });
  await new Promise((r) => m.server.listen(0, r));
  const base = `http://127.0.0.1:${m.server.address().port}`;
  const r = await F.runFetch(fetchEnv(base));
  assert.equal(r.replaced, 1); // told the caller — surfaces in the UI
  const pending = require('../server/lib/rosterSync').getPending();
  assert.equal(pending.replaced_count, 1);
  m.server.close();
});

test('admin endpoints: status shows the pending diff; approve commits it; log records it', async () => {
  const st = await req('GET', '/api/admin/roster-sync', { cookie: adminCookie });
  assert.equal(st.status, 200);
  assert.equal(st.json.pending.preview.added.length, 6);
  assert.equal(st.json.last_status, 'ok');
  assert.equal(st.json.running, false);

  // the job itself NEVER commits: nothing in person until approval
  assert.equal(db.prepare('SELECT COUNT(*) c FROM person').get().c, 0);

  const ap = await req('POST', '/api/admin/roster-sync/approve', { cookie: adminCookie });
  assert.equal(ap.status, 200);
  assert.equal(ap.json.added, 6);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM person').get().c, 6);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM person WHERE first_name = 'Emma'`).get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM roster_import').get().c, 1);

  // pending is consumed
  const st2 = await req('GET', '/api/admin/roster-sync', { cookie: adminCookie });
  assert.equal(st2.json.pending, null);
  const again = await req('POST', '/api/admin/roster-sync/approve', { cookie: adminCookie });
  assert.equal(again.status, 404);
});

test('discard clears the pending import without touching the roster', async () => {
  const m = makeMockTlc({ pendingPolls: 0 });
  await new Promise((r) => m.server.listen(0, r));
  const base = `http://127.0.0.1:${m.server.address().port}`;
  await F.runFetch(fetchEnv(base));
  m.server.close();
  const before_ = db.prepare('SELECT COUNT(*) c FROM person').get().c;
  const d = await req('POST', '/api/admin/roster-sync/discard', { cookie: adminCookie });
  assert.equal(d.json.discarded, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM person').get().c, before_);
  assert.equal((await req('GET', '/api/admin/roster-sync', { cookie: adminCookie })).json.pending, null);
});

// --------------------------------------------------------- failure paths ---
test('wrong password: exit path 2, exactly ONE login attempt, failure recorded', async () => {
  const m = makeMockTlc({});
  await new Promise((r) => m.server.listen(0, r));
  const base = `http://127.0.0.1:${m.server.address().port}`;
  await assert.rejects(
    () => F.runFetch(fetchEnv(base, { TLC_PASSWORD: 'wrong-password' })),
    (e) => e instanceof F.FetchError && e.code === 2 && /do NOT retry/.test(e.message));
  assert.equal(m.state.loginPosts, 1); // spec: no retry loop, ever
  m.server.close();
});

test('export that returns an HTML page (expired session look) is rejected by the sniffer', async () => {
  const m = makeMockTlc({ pendingPolls: 0, serveHtmlExport: true });
  await new Promise((r) => m.server.listen(0, r));
  const base = `http://127.0.0.1:${m.server.address().port}`;
  await assert.rejects(() => F.runFetch(fetchEnv(base)),
    (e) => e instanceof F.FetchError && e.code === 4 && /HTML/.test(e.message));
  m.server.close();
});

test('row-count guard end to end: a shrunken export aborts the run and stages nothing', async () => {
  // previous successful state says 113 rows; the mock serves the 7-row synthetic
  const cfg = F.makeConfig(fetchEnv('http://x'));
  F.writeState(cfg, { last_rows: 113 });
  const m = makeMockTlc({ pendingPolls: 0 });
  await new Promise((r) => m.server.listen(0, r));
  const base = `http://127.0.0.1:${m.server.address().port}`;
  await assert.rejects(() => F.runFetch(fetchEnv(base)),
    (e) => e instanceof F.FetchError && e.code === 4 && /mass-deactivate/.test(e.message));
  assert.equal(require('../server/lib/rosterSync').getPending(), null); // nothing staged
  // configurable tolerance lets an intentional shrink through
  const r = await F.runFetch(fetchEnv(base, { TLC_ROW_TOLERANCE: '0.95' }));
  assert.equal(r.rows, 7);
  await req('POST', '/api/admin/roster-sync/discard', { cookie: adminCookie });
  m.server.close();
});

// ------------------------------------------------- admin-saved credentials --
test('credentials API: write-only save, source reporting, blank-password keep, delete', async () => {
  // starts on env-style: none saved
  let st = await req('GET', '/api/admin/roster-sync', { cookie: adminCookie });
  assert.equal(st.json.credentials.source, null);
  assert.equal(st.json.configured, false); // this test env has no TLC_* vars

  // first save requires a password
  const bad = await req('PUT', '/api/admin/roster-sync/credentials',
    { cookie: adminCookie, body: { email: EMAIL } });
  assert.equal(bad.status, 400);

  const ok = await req('PUT', '/api/admin/roster-sync/credentials',
    { cookie: adminCookie, body: { email: EMAIL, password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.email, EMAIL);
  assert.ok(!('password' in ok.json)); // never echoed back

  st = await req('GET', '/api/admin/roster-sync', { cookie: adminCookie });
  assert.equal(st.json.credentials.source, 'admin');
  assert.equal(st.json.credentials.email, EMAIL);
  assert.equal(st.json.configured, true);
  assert.ok(!JSON.stringify(st.json).includes(PASSWORD)); // write-only, always

  // blank password on update keeps the stored one
  const upd = await req('PUT', '/api/admin/roster-sync/credentials',
    { cookie: adminCookie, body: { email: EMAIL } });
  assert.equal(upd.status, 200);
  const { getTlcCredentials } = require('../server/lib/rosterSync');
  assert.equal(getTlcCredentials().password, PASSWORD);

  // THE at-rest guarantee: the database row holds only ciphertext — the
  // plaintext password appears nowhere in the stored value (so DB snapshots
  // and nightly backups cannot leak it)
  const raw = db.prepare(`SELECT value FROM meta WHERE key = 'tlc_credentials'`).get().value;
  const parsed = JSON.parse(raw);
  assert.equal(parsed.enc, 1);
  assert.ok(parsed.password_enc && parsed.password_enc.iv && parsed.password_enc.tag);
  assert.ok(!raw.includes(PASSWORD), 'plaintext password must not exist in the DB');
  assert.ok(!('password' in parsed), 'no plaintext password field in the stored row');
  const st3 = await req('GET', '/api/admin/roster-sync', { cookie: adminCookie });
  assert.equal(st3.json.credentials.encrypted, true); // and the UI is told so
  assert.equal(st3.json.credentials.readable, true);

  // and they require an admin session
  assert.equal((await req('PUT', '/api/admin/roster-sync/credentials',
    { body: { email: 'x@x', password: 'y' } })).status, 401);
});

test('fetcher uses admin-saved credentials (DB wins over env) — no TLC_* in env at all', async () => {
  // credentials saved by the previous test; run a fetch with NONE in env
  const m = makeMockTlc({ pendingPolls: 0 });
  await new Promise((r) => m.server.listen(0, r));
  const base = `http://127.0.0.1:${m.server.address().port}`;
  const env = fetchEnv(base);
  delete env.TLC_EMAIL; delete env.TLC_PASSWORD;
  const r = await F.runFetch(env);
  assert.equal(r.rows, 7);
  assert.equal(m.state.loginPosts, 1);
  await req('POST', '/api/admin/roster-sync/discard', { cookie: adminCookie });

  // DB beats env: env has a WRONG password, DB has the right one → success
  const m2 = makeMockTlc({ pendingPolls: 0 });
  await new Promise((r2) => m2.server.listen(0, r2));
  const base2 = `http://127.0.0.1:${m2.server.address().port}`;
  const r2 = await F.runFetch(fetchEnv(base2, { TLC_PASSWORD: 'wrong-env-password' }));
  assert.equal(r2.rows, 7);
  await req('POST', '/api/admin/roster-sync/discard', { cookie: adminCookie });

  // delete → fetch with no env creds now fails at config, not at login
  const del = await req('DELETE', '/api/admin/roster-sync/credentials', { cookie: adminCookie });
  assert.equal(del.json.cleared, true);
  await assert.rejects(() => F.runFetch(env),
    (e) => e instanceof F.FetchError && e.code === 1);
  m.server.close(); m2.server.close();
});

test('legacy plaintext credential rows migrate to encrypted on first read', async () => {
  // simulate a row saved before encryption existed
  db.prepare(`INSERT INTO meta (key, value) VALUES ('tlc_credentials', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify({ email: EMAIL, password: PASSWORD, updated_at: '2026-07-27T00:00:00Z' }));
  const { getTlcCredentials } = require('../server/lib/rosterSync');
  const creds = getTlcCredentials(); // read still works…
  assert.equal(creds.password, PASSWORD);
  const raw = db.prepare(`SELECT value FROM meta WHERE key = 'tlc_credentials'`).get().value;
  assert.equal(JSON.parse(raw).enc, 1); // …and the row is now encrypted
  assert.ok(!raw.includes(PASSWORD));
  db.prepare(`DELETE FROM meta WHERE key = 'tlc_credentials'`).run(); // restore state for later tests
});

test('a changed CRED_KEY makes credentials unreadable loudly, not silently wrong', async () => {
  const { saveTlcCredentials, getTlcCredentials, credentialInfo } = require('../server/lib/rosterSync');
  saveTlcCredentials({ email: EMAIL, password: PASSWORD });
  const origKey = process.env.CRED_KEY;
  try {
    process.env.CRED_KEY = require('crypto').randomBytes(32).toString('hex'); // key lost/rotated
    assert.equal(getTlcCredentials(), null); // no wrong-password login attempts
    const info = credentialInfo({});
    assert.equal(info.source, 'admin');
    assert.equal(info.readable, false); // the UI can tell the admin exactly what happened
  } finally {
    process.env.CRED_KEY = origKey;
    db.prepare(`DELETE FROM meta WHERE key = 'tlc_credentials'`).run();
  }
});

test('TLC_ENABLED=false is a clean no-op', async () => {
  const r = await F.runFetch(fetchEnv('http://127.0.0.1:1', { TLC_ENABLED: 'false' }));
  assert.deepEqual(r, { skipped: true, reason: 'TLC_ENABLED=false' });
});

test('missing credentials fail fast with the config exit code', async () => {
  await assert.rejects(() => F.runFetch(fetchEnv('http://127.0.0.1:1', { TLC_EMAIL: '' })),
    (e) => e instanceof F.FetchError && e.code === 1);
});
