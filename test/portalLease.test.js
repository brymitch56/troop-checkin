'use strict';
// Portal session lease: lending the signed-in cookies to another program on
// the same machine, so it never signs in itself and never texts a human a
// code. The gates matter more than the payload — a session cookie is the
// right to act as the troop's portal account.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lease-'));
process.env.CRED_KEY = require('crypto').randomBytes(32).toString('hex'); // credCrypto wants 64 hex chars

const KEY = 'lease-key-that-is-long-enough-to-pass';
const auth = require('../server/auth');
const { db } = require('../server/db');
const portalSession = require('../server/lib/portalSession');

let server, base;
const saved = {};
const setEnv = (k, v) => { if (!(k in saved)) saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; };

const PORTAL = 'https://portal.example.com';
// saveCookies reads jar.map (name -> value), the shape fetch-roster's CookieJar has
const FAKE_JAR = { map: new Map([['PHPSESSID', 'fake-session-never-real'], ['_identity', 'fake-identity-never-real']]) };
const FAKE_COOKIES = ['PHPSESSID=fake-session-never-real', '_identity=fake-identity-never-real'];

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin L', 'admin', ?)`).run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  server && server.close();
});

const get = (opts = {}) => fetch(base + '/api/portal-lease', opts);
const withKey = (key = KEY, extra = {}) => ({ headers: { Authorization: `Bearer ${key}`, ...extra } });

function connect() {
  portalSession.saveCookies(FAKE_JAR, PORTAL);
}

test('unset PORTAL_LEASE_KEY: the route does not exist, so every install is unchanged', async () => {
  setEnv('PORTAL_LEASE_KEY', null);
  connect();
  const r = await get(withKey());
  assert.equal(r.status, 404);
  assert.equal((await r.json()).cookies, undefined);
});

test('a key shorter than the minimum does not enable it (a weak key is no key)', async () => {
  setEnv('PORTAL_LEASE_KEY', 'too-short');
  const r = await get(withKey('too-short'));
  assert.equal(r.status, 404);
});

test('enabled + loopback + right key: lends the cookies and where they point', async () => {
  setEnv('PORTAL_LEASE_KEY', KEY);
  connect();
  const r = await get(withKey());
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.connected, true);
  assert.equal(body.base, PORTAL);
  assert.deepEqual(body.cookies, FAKE_COOKIES);
  assert.ok(body.connected_at, 'says when it was established');
  // never cached by anything in the path
  assert.match(r.headers.get('cache-control') || '', /no-store/);
  // the credentials themselves are never in the payload
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /password|TLC_PASSWORD|CRED_KEY/i);
});

test('wrong key is refused, and refusals are indistinguishable from each other', async () => {
  setEnv('PORTAL_LEASE_KEY', KEY);
  const r = await get(withKey('wrong-key-of-exactly-the-same-length!'));
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'portal lease unavailable' });
  const missing = await get();
  assert.equal(missing.status, 401);
});

test('a forwarded request is refused even from loopback — the tunnel can never reach it', async () => {
  setEnv('PORTAL_LEASE_KEY', KEY);
  connect();
  for (const h of ['X-Forwarded-For', 'X-Real-IP', 'CF-Connecting-IP', 'Forwarded']) {
    const r = await get(withKey(KEY, { [h]: '203.0.113.9' }));
    assert.equal(r.status, 404, `${h} must not be honoured`);
  }
  // and the same request without the header still works, so the test is real
  assert.equal((await get(withKey())).status, 200);
});

test('nobody connected: says so plainly and lends nothing — the borrower must give up', async () => {
  setEnv('PORTAL_LEASE_KEY', KEY);
  portalSession.clearSession();
  const r = await get(withKey());
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.connected, false);
  assert.equal(body.cookies, undefined);
  assert.match(body.error, /connect in Admin/i);
});

test('the lease never signs in — a borrower cannot cause a text message', async () => {
  setEnv('PORTAL_LEASE_KEY', KEY);
  portalSession.clearSession();
  // hammering it while disconnected must stay a 409 and must never park a
  // challenge (which is what a sign-in attempt would leave behind)
  for (let i = 0; i < 3; i++) assert.equal((await get(withKey())).status, 409);
  assert.equal(portalSession.getChallenge(), null);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'portalLease.js'), 'utf8');
  assert.doesNotMatch(src, /fetch-roster|login\(|submitChallenge/, 'the route must not be able to sign in');
});

test('a borrower can report success, which is what dates the session lifetime', async () => {
  setEnv('PORTAL_LEASE_KEY', KEY);
  connect();
  const before = portalSession.sessionInfo().last_ok_at;
  const r = await fetch(base + '/api/portal-lease/used', { method: 'POST', ...withKey() });
  assert.equal(r.status, 200);
  const after = portalSession.sessionInfo().last_ok_at;
  assert.ok(after, 'last_ok_at is set');
  assert.notEqual(after, before === undefined ? null : before);
});

test('the integration API key does not open the lease (separate privileges)', async () => {
  setEnv('PORTAL_LEASE_KEY', KEY);
  connect();
  const integrationAuth = require('../server/lib/integrationAuth');
  const { key } = integrationAuth.generateKey('test');
  integrationAuth.setEnabled(1);
  const r = await get(withKey(key));
  assert.equal(r.status, 401, 'an integration key must not lend the portal session');
});
