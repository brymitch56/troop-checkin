'use strict';
// "Trust this browser" second factor (the AHGfamily shape, 2026-10).
//
// The sibling portal texts a code only when a sign-in comes from a browser it
// does not trust. Its code form carries a trust checkbox (a checkbox widget
// backed by a plain text input) and two submit buttons sharing one name
// (verify / resend); a verified sign-in with the box on earns a 30-day
// trusted_device cookie and deletes the remember-me identity cookie, so the
// signed-in session itself is short. An account that has not enrolled yet
// is fenced onto a setup page instead.
//
// These tests drive a MOCK portal with that behaviour: the code is posted
// with the trust option and the verify button, the trust cookie is stored
// apart from the session and survives the session dying, the next password
// sign-in skips the code, and the enrollment fence is a clear error rather
// than a "connected" session. All values are synthetic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-trust-'));
process.env.CRED_KEY = require('crypto').randomBytes(32).toString('hex');

require('../server/migrate');
const F = require('../server/scripts/fetch-roster');
const PS = require('../server/lib/portalSession');

const EMAIL = 'fake-leader@example.com';
const PASSWORD = 'fake-password-never-real';
const CODE = '654321';
const CSRF = 'MockCsrf' + 'C'.repeat(40);
const TRUST = 'fake-trust-token-' + 'd'.repeat(32);
const DAY = 24 * 3600 * 1000;

// The verify page, modelled on the real markup's shape (invented values).
const verifyPage = () =>
  `<html><head><meta name="csrf-token" content="${CSRF}"><title>Verify Login</title></head><body>
     <h1>Verify Login</h1>
     <div class="alert">Enter the verification code sent to the mobile number on your account to complete sign-in.</div>
     <form id="sms-verify-form" action="/site/sms-verify" method="post">
       <input type="hidden" name="_csrf" value="${CSRF}">
       <label>Verification Code</label>
       <input type="text" id="sms-verify-code" name="code" maxlength="6">
       <input type="text" id="w0" class="cbx-input" name="trust_device" value="1"> Trust this browser for 30 days
       <button type="submit" class="btn" name="sms_action" value="verify">Verify &amp; Continue</button>
       <button type="submit" class="btn" name="sms_action" value="resend">Resend Code</button>
       <a href="/login">Back to Login</a>
     </form></body></html>`;

const loginPage = () =>
  `<html><head><meta name="csrf-token" content="${CSRF}"></head><body><form method="post">
     <input type="hidden" name="_csrf" value="${CSRF}">
     <input name="LoginForm[email]"><input type="password" name="LoginForm[password]">
   </form></body></html>`;

const gatePage = () =>
  `<html><head><meta name="csrf-token" content="${CSRF}"><title>Account Security</title></head><body>
     <div id="mfa-is-gated"></div><h1>Multi-Factor Authentication</h1>
     <input type="checkbox" id="mfa-sms-agreement"><button id="mfa-sms-send">Text Me a Code</button>
   </body></html>`;

// --------------------------------------------------------- shape parsing ---
test('parseChallenge: the trust box is switched on and the VERIFY button is pressed', () => {
  const c = F.parseChallenge(verifyPage(), '/site/login');
  assert.ok(c);
  assert.equal(c.action, '/site/sms-verify');
  assert.equal(c.field, 'code');
  assert.deepEqual(c.options, { trust_device: '1' });
  assert.deepEqual({ name: c.submit.name, value: c.submit.value }, { name: 'sms_action', value: 'verify' });
  assert.match(c.prompt, /^Enter the verification code sent/);
});

test('pickSubmit: never the resend button, whatever order they come in', () => {
  const body = `<button name="act" value="resend">Resend Code</button>
                <button name="act" value="go">Verify &amp; Continue</button>`;
  assert.equal(F.pickSubmit(body).value, 'go');
  assert.equal(F.pickSubmit('<button name="act" value="resend">Resend</button>'), null);
  assert.equal(F.pickSubmit('<button type="submit">Verify</button>'), null); // unnamed posts nothing
});

test('parseChallenge: a trust CHECKBOX posts its own value', () => {
  const html = `<form action="/v" method="post"><input name="otp">
    <input type="checkbox" name="remember_browser" value="yes"></form>`;
  assert.deepEqual(F.parseChallenge(html, '/login').options, { remember_browser: 'yes' });
});

test('CookieJar: remembers expiry, and only persistent trust cookies count as trust', () => {
  const jar = new F.CookieJar();
  const in30 = new Date(Date.now() + 30 * DAY).toUTCString();
  jar.absorbLines([
    `trusted_device=${TRUST}; expires=${in30}; Path=/; Secure; HttpOnly`,
    'PHPSESSID=abc; Path=/; HttpOnly',
    `_identity=keep; expires=${in30}; Path=/`,          // persistent but not a trust cookie
    'device_hint=x; Path=/',                             // trust-ish name, but a session cookie
  ]);
  const t = jar.trustLines();
  assert.equal(t.length, 1);
  assert.match(t[0], new RegExp(`^trusted_device=${TRUST}; Expires=`));
  // a restored line keeps its date, and a deletion forgets it
  const j2 = new F.CookieJar();
  j2.absorbLines(t);
  assert.equal(j2.trustLines().length, 1);
  j2.absorbLines(['trusted_device=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Path=/']);
  assert.equal(j2.trustLines().length, 0);
  assert.equal(j2.size, 0);
});

test('isEnrollmentGate: the setup page by marker or by address', () => {
  assert.equal(F.isEnrollmentGate(gatePage(), 'https://portal.test/anything'), true);
  assert.equal(F.isEnrollmentGate('<html></html>', 'https://portal.test/user/mfa-setup'), true);
  assert.equal(F.isEnrollmentGate(verifyPage(), 'https://portal.test/site/sms-verify'), false);
});

// ------------------------------------------------------------ mock portal ---
let server, base;
const state = {
  enrolled: true, texts: 0, verifyPosts: [], loginPosts: 0,
  sessions: new Set(), // live session ids; empty it to "expire" every session
  nextSess: 1,
};
const cookieOf = (req, name) => (new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie || '') || [])[1];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const sess = cookieOf(req, 'PHPSESSID') || '';
      const live = state.sessions.has(sess);
      const gated = sess.startsWith('gated-') && !state.enrolled;
      const go = (loc, cookies = []) => { res.writeHead(302, { Location: loc, 'Set-Cookie': cookies }); res.end(); };
      const html = (s, cookies = []) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': cookies }); res.end(s); };
      const newSess = (prefix) => `${prefix}-${state.nextSess++}`;

      if (gated) return url.pathname === '/user/mfa-setup' ? html(gatePage()) : go('/user/mfa-setup');

      if (req.method === 'GET' && url.pathname === '/site/login') {
        return live ? go('/dashboard/index') : html(loginPage(), [`_csrf=cookietok; Path=/; HttpOnly`]);
      }
      if (req.method === 'POST' && url.pathname === '/site/login') {
        state.loginPosts++;
        const p = new URLSearchParams(body);
        if (p.get('LoginForm[email]') !== EMAIL || p.get('LoginForm[password]') !== PASSWORD) return html(loginPage());
        if (!state.enrolled) return go('/user/mfa-setup', [`PHPSESSID=${newSess('gated')}; Path=/; HttpOnly`]);
        if (cookieOf(req, 'trusted_device') === TRUST) {
          const s = newSess('ok'); state.sessions.add(s);
          return go('/dashboard/index', [`PHPSESSID=${s}; Path=/; HttpOnly`]);
        }
        state.texts++;
        return go('/site/sms-verify', [`PHPSESSID=${newSess('half')}; Path=/; HttpOnly`]);
      }
      if (req.method === 'GET' && url.pathname === '/site/sms-verify') return html(verifyPage());
      if (req.method === 'POST' && url.pathname === '/site/sms-verify') {
        const p = new URLSearchParams(body);
        state.verifyPosts.push(Object.fromEntries(p));
        if (!sess.startsWith('half-') || p.get('_csrf') !== CSRF) { res.writeHead(403); return res.end(); }
        if (p.get('sms_action') === 'resend') { state.texts++; return html(verifyPage()); }
        if (p.get('sms_action') !== 'verify' || p.get('code') !== CODE) return html(verifyPage());
        const s = newSess('ok'); state.sessions.add(s);
        const cookies = [
          `PHPSESSID=${s}; Path=/; HttpOnly`,
          '_identity=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; Path=/; HttpOnly',
        ];
        if (p.get('trust_device') === '1') {
          cookies.push(`trusted_device=${TRUST}; expires=${new Date(Date.now() + 30 * DAY).toUTCString()}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax`);
        }
        return go('/dashboard/index', cookies);
      }
      if (req.method === 'GET' && url.pathname === '/dashboard/index') {
        return live ? html(`<html><head><meta name="csrf-token" content="${CSRF}"></head><body>Dashboard</body></html>`)
          : go('/site/login');
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

const cfg = (email = EMAIL) => F.makeConfig({
  TLC_BASE: base, TLC_LOGIN_PATH: '/site/login', TLC_EMAIL: email, TLC_PASSWORD: PASSWORD,
  DATA_DIR: process.env.DATA_DIR,
});

// ------------------------------------------------------------- the flow ----
test('first sign-in: a code is texted and the prompt is parked', async () => {
  PS.clearSession(); PS.clearChallenge();
  const err = await F.login(cfg(), new F.CookieJar(), { useStored: false }).then(() => null, (e) => e);
  assert.equal(err && err.code, 6);
  assert.equal(state.texts, 1);
  assert.match(err.message, /verification code sent to the mobile number/);
});

test('entering the code posts the trust option and the verify button, and stores the trust', async () => {
  const parked = PS.getChallenge();
  const jar = new F.CookieJar();
  jar.absorbLines(parked.cookies);
  await F.submitChallenge(cfg(), jar, parked.challenge, CODE);

  const sent = state.verifyPosts.at(-1);
  assert.equal(sent.trust_device, '1');
  assert.equal(sent.sms_action, 'verify');
  assert.equal(sent.code, CODE);

  const info = PS.sessionInfo();
  assert.equal(info.connected, true);
  const days = (Date.parse(info.trusted_until) - Date.now()) / DAY;
  assert.ok(days > 29 && days <= 30, `trusted for ~30 days, got ${days}`);
  // ciphertext at rest, like the session itself
  const { db } = require('../server/db');
  assert.doesNotMatch(db.prepare("SELECT value FROM meta WHERE key = 'portal_trust'").get().value, /fake-trust-token/);
});

test('the session dies, the trust does not: the password sign-in skips the code', async () => {
  state.sessions.clear(); // the portal expired every session (no remember-me cookie survives)
  const texts = state.texts;
  const posts = state.loginPosts;
  const jar = new F.CookieJar();
  const token = await F.login(cfg(), jar);
  assert.ok(token, 'signed in without a code');
  assert.equal(state.loginPosts, posts + 1, 'the dead session was detected and the password used');
  assert.equal(state.texts, texts, 'no text message was sent');
  assert.ok(PS.sessionInfo().trusted_until, 'the trust is still on file');
});

test('a forced reconnect (useStored:false) also uses the trust', async () => {
  const texts = state.texts;
  const token = await F.login(cfg(), new F.CookieJar(), { useStored: false });
  assert.ok(token);
  assert.equal(state.texts, texts);
});

test('the trust is never offered for a different account', async () => {
  assert.ok(PS.loadTrust(base, EMAIL.toUpperCase()), 'same account, any case');
  assert.equal(PS.loadTrust(base, 'someone-else@example.com'), null);
  assert.equal(PS.loadTrust('https://other-portal.test', EMAIL), null);
});

test('an expired trust is dropped and the next sign-in asks for a code again', async () => {
  const { db } = require('../server/db');
  const row = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'portal_trust'").get().value);
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  db.prepare("UPDATE meta SET value = ? WHERE key = 'portal_trust'").run(JSON.stringify(row));
  assert.equal(PS.loadTrust(base, EMAIL), null);
  assert.equal(PS.sessionInfo().trusted_until, null);
});

test('Disconnect forgets the trust along with the session', async () => {
  // re-establish trust, then forget it
  state.sessions.clear();
  const err = await F.login(cfg(), new F.CookieJar(), { useStored: false }).then(() => null, (e) => e);
  assert.equal(err.code, 6);
  const parked = PS.getChallenge();
  const jar = new F.CookieJar(); jar.absorbLines(parked.cookies);
  await F.submitChallenge(cfg(), jar, parked.challenge, CODE);
  assert.ok(PS.loadTrust(base, EMAIL));
  PS.clearSession();
  assert.equal(PS.loadTrust(base, EMAIL), null);
  assert.equal(PS.sessionInfo().trusted_until, null);
});

test('a trust box left OFF earns no trust (proves the option is what does it)', async () => {
  PS.clearSession(); PS.clearChallenge();
  const err = await F.login(cfg(), new F.CookieJar(), { useStored: false }).then(() => null, (e) => e);
  assert.equal(err.code, 6);
  const parked = PS.getChallenge();
  const jar = new F.CookieJar(); jar.absorbLines(parked.cookies);
  await F.submitChallenge(cfg(), jar, { ...parked.challenge, options: {} }, CODE);
  assert.equal(PS.sessionInfo().trusted_until, null);
  PS.clearSession();
});

test('an account not yet enrolled: a clear error (8), never a "connected" session', async () => {
  PS.clearSession(); PS.clearChallenge();
  state.enrolled = false;
  const jar = new F.CookieJar();
  const err = await F.login(cfg(), jar, { useStored: false }).then(() => null, (e) => e);
  assert.equal(err && err.code, 8);
  assert.match(err.message, /browser/);
  assert.equal(PS.sessionInfo().connected, false);
  assert.equal(PS.challengeInfo(), null, 'nothing to type a code into');

  // a stored session that later got fenced off is not mistaken for a live one
  PS.saveCookies(jar, base);
  assert.equal(await F.probeSession(cfg(), jar), null);
  state.enrolled = true;
  PS.clearSession();
});
