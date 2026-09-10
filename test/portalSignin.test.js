'use strict';
// Portal sign-in with a second factor (lib/portalSession + the challenge
// half of scripts/fetch-roster.js).
//
// The portal now answers a correct password with "enter the code we texted
// you" instead of a session. These tests cover the whole human-in-the-loop
// flow against a MOCK portal that behaves that way: the code form is
// recognised by shape, parked encrypted, finished with a typed code, and the
// resulting session is reused by later sign-ins so no unattended job ever
// meets a code prompt. Everything is synthetic — obviously fake credentials,
// a code of 123456, no real network.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-portal-'));
process.env.CRED_KEY = require('crypto').randomBytes(32).toString('hex');

require('../server/migrate');
const F = require('../server/scripts/fetch-roster');
const PS = require('../server/lib/portalSession');

const EMAIL = 'fake-troopmaster@example.com';
const PASSWORD = 'fake-password-never-real';
const CODE = '123456';
const TOKEN = 'MockCsrf' + 'A'.repeat(40);

// --------------------------------------------------------- shape parsing ---
const codeForm = (csrf, action = '/login/mfa', field = 'MfaForm[code]') =>
  `<html><head><meta name="csrf-token" content="${csrf}"></head><body>
     <h1>Verify it's you</h1>
     <p>We sent a code to the phone ending 1234. It expires in 10 minutes.</p>
     <form action="${action}" method="post">
       <input type="hidden" name="_csrf" value="${csrf}">
       <input type="hidden" name="rememberMe" value="1">
       <input type="text" name="${field}" maxlength="6" autocomplete="one-time-code">
       <button type="submit">Verify</button>
     </form></body></html>`;

const loginForm = (csrf) =>
  `<html><head><meta name="csrf-token" content="${csrf}"></head><body><form method="post">
     <input type="hidden" name="_csrf" value="${csrf}">
     <input name="LoginForm[email]"><input type="password" name="LoginForm[password]">
   </form></body></html>`;

test('parseChallenge: finds the code form, its action, field and hidden inputs', () => {
  const c = F.parseChallenge(codeForm(TOKEN), '/login');
  assert.ok(c);
  assert.equal(c.action, '/login/mfa');
  assert.equal(c.field, 'MfaForm[code]');
  assert.equal(c.csrf, TOKEN);
  assert.equal(c.hidden._csrf, TOKEN);
  assert.equal(c.hidden.rememberMe, '1'); // every hidden input rides along
  assert.match(c.prompt, /sent a code to the phone ending 1234/);
});

test('parseChallenge: the re-rendered LOGIN form is a rejected password, not a code prompt', () => {
  assert.equal(F.parseChallenge(loginForm(TOKEN), '/login'), null);
});

test('parseChallenge: an ordinary page with a search box is not a code prompt', () => {
  const page = `<html><body><form action="/search"><input type="text" name="q"></form></body></html>`;
  assert.equal(F.parseChallenge(page, '/dashboard'), null);
});

test('parseChallenge: alternate field names are recognised by shape', () => {
  for (const name of ['otp', 'verification_code', 'TwoFactor[token]', 'auth-pin']) {
    const c = F.parseChallenge(codeForm(TOKEN, '/x', name), '/login');
    assert.ok(c, `expected ${name} to read as a code field`);
    assert.equal(c.field, name);
  }
});

test('parseChallenge: an unrecognisable field name can be pinned with TLC_MFA_FIELD', () => {
  const html = codeForm(TOKEN, '/x', 'zz9');
  assert.equal(F.parseChallenge(html, '/login'), null);
  const c = F.parseChallenge(html, '/login', { mfaField: 'zz9', mfaPath: '/pinned' });
  assert.equal(c.field, 'zz9');
  assert.equal(c.action, '/pinned'); // TLC_MFA_PATH wins over the form's own action
});

test('challengePrompt: takes the sentence about the code, not the heading above it', () => {
  assert.match(F.challengePrompt(codeForm(TOKEN)), /^We sent a code/);
  assert.equal(F.challengePrompt('<html><body><p>Nothing to see</p></body></html>'), null);
});

// ------------------------------------------------------------ mock portal ---
let server, base;
const state = { loginPosts: 0, codePosts: 0, sessionDead: false, csrf: TOKEN };

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const cookie = req.headers.cookie || '';
      const signedIn = /PORTALSESS=ok/.test(cookie) && !state.sessionDead;

      if (req.method === 'GET' && url.pathname === '/login') {
        // A live session is redirected away from the form — the exact
        // behaviour probeSession() relies on.
        if (signedIn) { res.writeHead(302, { Location: '/dashboard' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['_csrf-frontend=cookietok; Path=/'] });
        return res.end(loginForm(state.csrf));
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        state.loginPosts++;
        const p = new URLSearchParams(body);
        if (p.get('LoginForm[email]') !== EMAIL || p.get('LoginForm[password]') !== PASSWORD) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(loginForm(state.csrf));
        }
        // password accepted — hand back the code form, half-authenticated
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['PORTALHALF=1; Path=/'] });
        return res.end(codeForm(state.csrf));
      }
      if (req.method === 'POST' && url.pathname === '/login/mfa') {
        state.codePosts++;
        const p = new URLSearchParams(body);
        if (!/PORTALHALF=1/.test(cookie) || p.get('_csrf') !== state.csrf) { res.writeHead(403); return res.end(); }
        if (p.get('MfaForm[code]') !== CODE) {
          state.csrf = 'Rotated' + 'B'.repeat(40); // a refused code rotates the token
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(codeForm(state.csrf));
        }
        state.sessionDead = false;
        res.writeHead(302, { Location: '/dashboard', 'Set-Cookie': ['PORTALSESS=ok; Path=/', 'PORTALHALF=; Path=/'] });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/dashboard') {
        if (!signedIn) { res.writeHead(302, { Location: '/login' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<html><head><meta name="csrf-token" content="${state.csrf}"></head><body>Dashboard</body></html>`);
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

const cfg = () => F.makeConfig({
  TLC_BASE: base, TLC_EMAIL: EMAIL, TLC_PASSWORD: PASSWORD, DATA_DIR: process.env.DATA_DIR,
});

// ------------------------------------------------------------- the flow ----
test('login: a portal that wants a code throws FetchError(6) and parks the prompt', async () => {
  PS.clearSession(); PS.clearChallenge();
  const jar = new F.CookieJar();
  const err = await F.login(cfg(), jar).then(() => null, (e) => e);
  assert.ok(err, 'login should not resolve when a code is required');
  assert.equal(err.code, 6);
  assert.match(err.message, /sign-in code/i);
  assert.match(err.message, /phone ending 1234/); // the portal's own wording reaches the admin

  const info = PS.challengeInfo();
  assert.ok(info && info.id, 'the prompt is parked for the admin page');
  assert.ok(Date.parse(info.expires_at) > Date.now());
  assert.equal(PS.sessionInfo().connected, false); // half-authenticated is not connected
});

test('parked challenge: the cookies and form are readable back, and are NOT stored in the clear', async () => {
  const parked = PS.getChallenge(PS.challengeInfo().id);
  assert.ok(parked.cookies.some((c) => /PORTALHALF=1/.test(c)));
  assert.equal(parked.challenge.field, 'MfaForm[code]');
  // the raw meta row is ciphertext — a database snapshot leaks nothing usable
  const { db } = require('../server/db');
  const raw = db.prepare("SELECT value FROM meta WHERE key = 'portal_challenge'").get().value;
  assert.doesNotMatch(raw, /PORTALHALF/);
  assert.doesNotMatch(raw, /MfaForm/);
});

test('a wrong code is refused, keeps the prompt alive, and refreshes the form token', async () => {
  const parked = PS.getChallenge();
  const jar = new F.CookieJar();
  jar.absorbLines(parked.cookies);
  const err = await F.submitChallenge(cfg(), jar, parked.challenge, '000000').then(() => null, (e) => e);
  assert.equal(err.code, 7);
  assert.ok(err.challenge, 'the refreshed form comes back so the admin can retype');
  assert.notEqual(err.challenge.csrf, parked.challenge.csrf);
  assert.equal(PS.sessionInfo().connected, false);
  // the admin route re-parks the refreshed form so the SAME text message is
  // still usable — a rejected digit never costs another code
  PS.putChallenge({ base, cookies: jar.lines(), challenge: err.challenge, prompt: parked.prompt });
});

test('the right code finishes the sign-in and stores the session', async () => {
  const parked = PS.getChallenge();
  const jar2 = new F.CookieJar();
  jar2.absorbLines(parked.cookies);
  const token = await F.submitChallenge(cfg(), jar2, parked.challenge, CODE);
  assert.ok(token, 'the signed-in page yields a CSRF token for later XHR calls');
  assert.equal(PS.sessionInfo().connected, true);
  assert.equal(PS.challengeInfo(), null, 'the spent prompt is cleared');
});

test('later sign-ins reuse the stored session — no password, no second code', async () => {
  const before = state.loginPosts;
  const jar = new F.CookieJar();
  const token = await F.login(cfg(), jar);
  assert.ok(token);
  assert.equal(state.loginPosts, before, 'the password was never posted again');
  assert.match(jar.header(), /PORTALSESS=ok/);
});

test('useStored:false forces a real sign-in even with a good session', async () => {
  const before = state.loginPosts;
  const err = await F.login(cfg(), new F.CookieJar(), { useStored: false }).then(() => null, (e) => e);
  assert.equal(state.loginPosts, before + 1);
  assert.equal(err.code, 6); // and the portal asks for a code again, as it always does
  PS.clearChallenge();
});

test('an expired portal session falls back to the password and asks for a code again', async () => {
  state.sessionDead = true;
  const before = state.loginPosts;
  const err = await F.login(cfg(), new F.CookieJar()).then(() => null, (e) => e);
  assert.equal(err.code, 6);
  assert.equal(state.loginPosts, before + 1, 'the dead session is detected, then the password is used');
  assert.ok(PS.challengeInfo(), 'a fresh prompt is parked for the admin');
  state.sessionDead = false;
});

test('an expired prompt is not answerable, and Disconnect forgets the session', async () => {
  const c = PS.getChallenge();
  assert.ok(c);
  // age it past the TTL the same way the clock would
  const { db } = require('../server/db');
  const row = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'portal_challenge'").get().value);
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  db.prepare("UPDATE meta SET value = ? WHERE key = 'portal_challenge'").run(JSON.stringify(row));
  assert.equal(PS.challengeInfo(), null);
  assert.equal(PS.getChallenge(), null);

  PS.clearSession();
  assert.equal(PS.sessionInfo().connected, false);
});

test('a stored session for a different portal is never offered to this one', () => {
  const jar = new F.CookieJar();
  jar.absorbLines(['PORTALSESS=ok']);
  PS.saveCookies(jar, 'https://www.example-portal.test');
  assert.equal(PS.loadCookies(base), null);
  assert.ok(PS.loadCookies('https://www.example-portal.test'));
  PS.clearSession();
});
