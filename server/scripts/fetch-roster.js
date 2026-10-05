'use strict';
/**
 * fetch-roster.js — pull the member export from Trail Life Connect (TLC).
 *
 * No dependencies beyond Node 20 (global fetch) + the existing xlsx package.
 * Runs standalone (systemd timer / CLI) or via the admin "Sync now" button.
 *
 * Flow (docs/10-roster-sync.md — observed TLC behaviour, July 2026):
 *   1. GET  /login                            → _csrf cookie + token
 *   2. POST /login                            → session cookie (302 on success)
 *      …or, when the portal requires a second factor, a CODE FORM instead:
 *      the half-authenticated jar and that form are parked in lib/
 *      portalSession for a human to finish in Admin → Import, and a
 *      successful sign-in stores the cookie jar so later runs skip the
 *      password (and the code) entirely — see lib/portalSession.js
 *   3. GET  $TLC_EXPORT_PATH                  → 503, kicks off async export job
 *   4. POST /databuilder/get-download-status  → {"status":"pending"|"finished"}
 *      (headers: X-CSRF-Token, X-Requested-With: XMLHttpRequest)
 *   5. GET  $TLC_EXPORT_PATH                  → 200, the file
 *   6. Sniff bytes (server mislabels CSV as spreadsheetml — never trust
 *      Content-Type), sanity-check, write to data/roster-exports/ (mode 600),
 *      stage a PENDING IMPORT (preview only — never commits), exit 0.
 *
 * Safety rules (non-negotiable, from the spec):
 *   - never commits an import; a human approves in the admin UI
 *   - a failed login exits immediately — NO retry loop (TLC may lock the acct)
 *   - row-count guard vs the previous successful fetch (default 20%, strict
 *     while the TLC filter-persistence question is open; TLC_ROW_TOLERANCE)
 *   - credentials never appear in logs/errors; downloads are PII (mode 600,
 *     pruned after TLC_RETAIN_DAYS, dir covered by .gitignore's data/)
 *
 * Env (.env, chmod 600, gitignored — see .env.example):
 *   TLC_EMAIL, TLC_PASSWORD, TLC_ENABLED, TLC_BASE, TLC_EXPORT_PATH,
 *   TLC_ROW_TOLERANCE, TLC_POLL_MS, TLC_POLL_MAX, TLC_RETAIN_DAYS,
 *   HEALTHCHECK_URL, DATA_DIR
 *
 * Exit codes: 0 ok/disabled · 1 config · 2 auth · 3 export · 4 sanity check
 *             · 5 staging (file saved but pending-import creation failed)
 *             · 6 sign-in code required (a human must enter it in the admin)
 *             · 7 sign-in code rejected
 *             · 8 the account must enroll in two-step sign-in first (browser)
 */

const fs = require('fs');
const path = require('path');
// Self-load .env exactly like the app does (same proven parser; values
// already in process.env win). Without this, a plain `node fetch-roster.js`
// and the systemd timer had no credentials — found in the 2026-07-26 live
// test, where only a manual `-r ./server/lib/env.js` preload worked.
require('../lib/env');

// ---------------------------------------------------------------- errors ---
class FetchError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}
const fail = (code, msg) => { throw new FetchError(code, msg); };

// ---------------------------------------------------------------- config ---
function makeConfig(env = process.env) {
  const dataDir = env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return {
    enabled: String(env.TLC_ENABLED || 'true').toLowerCase() !== 'false',
    email: env.TLC_EMAIL || '',
    password: env.TLC_PASSWORD || '',
    base: (env.TLC_BASE || 'https://www.traillifeconnect.com').replace(/\/$/, ''),
    // xlsx by default — the format the import parser was validated against
    exportPath: env.TLC_EXPORT_PATH || '/user/index?export=xlsx&new=0',
    // Overridable for sibling portals on the same platform (AHGfamily.org
    // serves its login form at /site/login; network inspection 2026-08-02
    // confirmed the same /databuilder/get-download-status poll endpoint):
    loginPath: env.TLC_LOGIN_PATH || '/login',
    statusPath: env.TLC_STATUS_PATH || '/databuilder/get-download-status',
    // Second-factor escape hatches. The code form is normally found by
    // shape (see parseChallenge), so these stay empty unless a portal
    // renders something the detector cannot see: TLC_MFA_FIELD pins the
    // code input's name, TLC_MFA_PATH pins where to post it.
    mfaField: env.TLC_MFA_FIELD || '',
    mfaPath: env.TLC_MFA_PATH || '',
    // Cheap page used to test whether a STORED session is still signed in;
    // the login path is ideal because a live session redirects away from it.
    probePath: env.TLC_PROBE_PATH || '',
    dataDir,
    outDir: path.join(dataDir, 'roster-exports'),
    stateFile: path.join(dataDir, 'roster-fetch-state.json'),
    pollMax: Number(env.TLC_POLL_MAX) > 0 ? Number(env.TLC_POLL_MAX) : 40, // ~2 min at 3 s
    pollMs: Number(env.TLC_POLL_MS) > 0 ? Number(env.TLC_POLL_MS) : 3000,
    rowTolerance: env.TLC_ROW_TOLERANCE !== undefined && env.TLC_ROW_TOLERANCE !== ''
      ? Number(env.TLC_ROW_TOLERANCE) : 0.2,
    retainDays: Number(env.TLC_RETAIN_DAYS) > 0 ? Number(env.TLC_RETAIN_DAYS) : 56, // 8 weeks
    healthcheckUrl: env.HEALTHCHECK_URL || '',
    userAgent: 'troop-checkin-roster-sync/1.0 (+self-hosted troop tool)',
  };
}

// ------------------------------------------------------------ cookie jar ---
// Device-trust cookie names: AHGfamily sets "trusted_device"; the pattern is
// loose on purpose so a sibling portal's "remember_device"/"mfa_trust" also
// counts. Only ever matched against cookies that carry a future expiry.
const TRUST_COOKIE_RE = /trust|device/i;

// Hand-rolled: keep every cookie the site sets, honor deletions (empty value,
// Max-Age<=0, or an Expires date in the past — Yii uses 1970 but any past
// date must count), last write wins. Expiry times are remembered (ms, or
// absent for a browser-session cookie) so a long-lived "trusted device"
// cookie can be told apart from the session it rode in with.
class CookieJar {
  constructor() { this.map = new Map(); this.expires = new Map(); }
  absorbLines(lines) {
    for (const line of lines || []) {
      if (!line) continue;
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      let del = value === '';
      let until = null;
      for (const attr of attrs) {
        const j = attr.indexOf('=');
        const key = (j < 0 ? attr : attr.slice(0, j)).trim().toLowerCase();
        const val = j < 0 ? '' : attr.slice(j + 1).trim();
        if (key === 'max-age') {
          if (Number(val) <= 0) del = true;
          else until = Date.now() + Number(val) * 1000; // Max-Age beats Expires
        }
        if (key === 'expires') {
          const d = new Date(val);
          if (!isNaN(d) && d.getTime() < Date.now()) del = true;
          else if (!isNaN(d) && until === null) until = d.getTime();
        }
      }
      if (del) { this.map.delete(name); this.expires.delete(name); continue; }
      this.map.set(name, value);
      if (until !== null) this.expires.set(name, until);
      else if (attrs.length) this.expires.delete(name); // re-set as a session cookie
    }
  }
  absorb(res) {
    const lines = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [].concat(res.headers.get('set-cookie') || []);
    this.absorbLines(lines);
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  // "name=value" lines — what portalSession stores and absorbLines() takes.
  lines() { return [...this.map].map(([k, v]) => `${k}=${v}`); }
  // The cookies that mark THIS server as a trusted browser — the portal's
  // "Trust this browser for 30 days" box. Persistent (an expiry in the
  // future) and named for what they are. Returned with their Expires so a
  // restore keeps the date. These must outlive the session they came with:
  // dropping one means the next sign-in texts the account holder again.
  trustLines() {
    const out = [];
    for (const [k, v] of this.map) {
      const until = this.expires.get(k);
      if (!until || until <= Date.now() || !TRUST_COOKIE_RE.test(k)) continue;
      out.push(`${k}=${v}; Expires=${new Date(until).toUTCString()}`);
    }
    return out;
  }
  clear() { this.map.clear(); this.expires.clear(); }
  get size() { return this.map.size; }
}

// --------------------------------------------------------------- request ---
// Manual redirect following so cookies set mid-chain (e.g. the session cookie
// on the login 302) are absorbed. Redirects are always refetched as GET
// without the original body — correct for the 302-after-POST login flow.
async function request(cfg, jar, pathOrUrl, opts = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : cfg.base + pathOrUrl;
  const baseHeaders = () => ({
    'User-Agent': cfg.userAgent,
    'Accept-Language': 'en-US,en;q=0.9',
    ...(jar.size ? { Cookie: jar.header() } : {}),
    ...(opts.headers || {}),
  });
  let res = await fetch(url, { ...opts, headers: baseHeaders(), redirect: 'manual' });
  jar.absorb(res);
  let hops = 0;
  let from = url;
  while (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops++ < 5) {
    const next = new URL(res.headers.get('location'), from).toString();
    const h = baseHeaders();
    delete h['Content-Type']; // never re-send POST headers on the redirect GET
    h.Cookie = jar.header();
    res = await fetch(next, { headers: h, redirect: 'manual' });
    jar.absorb(res);
    from = next;
  }
  res._redirected = hops > 0; // eslint-disable-line no-underscore-dangle
  return res;
}

// ------------------------------------------------------------------ csrf ---
const decodeHtml = (s) => s
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#0?34;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Yii2 renders the token both as <meta name="csrf-token" content="..."> and
// as a hidden <input name="_csrf" value="..."> in the form (attribute order
// varies). Prefer the meta tag; fall back to the hidden field.
function csrfFrom(html) {
  const meta = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
  if (meta) return decodeHtml(meta[1]);
  const hidden = html.match(/name=["']_csrf[^"']*["'][^>]*value=["']([^"']+)["']/i)
              || html.match(/value=["']([^"']+)["'][^>]*name=["']_csrf[^"']*["']/i);
  return hidden ? decodeHtml(hidden[1]) : null;
}

// ------------------------------------------------------- second factor ---
// The portal now answers a correct password with a "enter the code we texted
// you" form instead of a session. We have to recognise that form and repost
// it later with a code a human typed, WITHOUT hard-coding field names we
// have not seen: the two sibling portals differ, and either can change.
//
// So the form is found by SHAPE, in this order of evidence:
//   - it is a <form> with no password input (that would be the login form
//     re-rendered after a bad password — a different failure entirely), and
//   - it has a short free-text input whose name looks like a code field
//     (TLC_MFA_FIELD pins the name if a portal ever names it something
//     unrecognisable), and
//   - its hidden inputs (Yii's _csrf among them) are carried along verbatim,
//     because reposting the form is exactly what a browser would do, and
//   - a "trust this browser" / "remember me" option is switched ON, and when
//     the form has several named submit buttons the verify one is pressed.
//     AHGfamily's form needs both: trust_device=1 (a checkbox widget backed
//     by a plain text input) earns a 30-day trusted_device cookie, and
//     sms_action=verify tells it apart from sms_action=resend. Without the
//     trust option every later sign-in texts the account holder again.
// Everything else on the page is ignored.

// Minimal tag scanners — the file already parses HTML with regexes rather
// than pulling in a DOM dependency, and these follow the same rule.
function attrOf(tagAttrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tagAttrs);
  if (!m) return null;
  const v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
  return decodeHtml(v || '');
}
function formsIn(html) {
  const out = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ attrs: m[1], body: m[2] });
  return out;
}
function inputsIn(body) {
  const out = [];
  const re = /<input\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(body))) {
    const name = attrOf(m[1], 'name');
    if (!name) continue;
    out.push({ name, type: (attrOf(m[1], 'type') || 'text').toLowerCase(), value: attrOf(m[1], 'value') || '' });
  }
  return out;
}
// Named submit controls: <button name=… value=…>label</button> (type defaults
// to submit) and <input type="submit|image" name=… value=…>.
function submitsIn(body) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(body))) {
    const type = (attrOf(m[1], 'type') || 'submit').toLowerCase();
    const name = attrOf(m[1], 'name');
    if (type !== 'submit' || !name) continue;
    const label = decodeHtml(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    out.push({ name, value: attrOf(m[1], 'value') || '', label });
  }
  for (const i of body.match(/<input\b[^>]*>/gi) || []) {
    const type = (attrOf(i, 'type') || '').toLowerCase();
    const name = attrOf(i, 'name');
    if ((type === 'submit' || type === 'image') && name) out.push({ name, value: attrOf(i, 'value') || '', label: attrOf(i, 'value') || '' });
  }
  return out;
}

const TRUST_FIELD_RE = /trust|remember/i;
const VERIFY_BUTTON_RE = /verify|confirm|continue|submit|sign.?in|log.?in/i;
const NOT_VERIFY_RE = /resend|send.*(new|again|another)|new code|back|cancel/i;

// The button a person would press to send the code: the one that reads as
// verify/continue, never resend/back. null when the form has no named
// submit (then nothing extra is posted, as a browser would do).
function pickSubmit(body) {
  const named = submitsIn(body);
  const looks = (b) => `${b.value} ${b.label}`;
  return named.find((b) => VERIFY_BUTTON_RE.test(looks(b)) && !NOT_VERIFY_RE.test(looks(b)))
    || named.find((b) => !NOT_VERIFY_RE.test(looks(b)))
    || null;
}

// Names seen or plausible for a one-time-code input across this platform and
// its siblings. Anchored to a word boundary so "passcode_hint" style names do
// not sneak past on a substring.
const CODE_FIELD_RE = /(^|[[\]_.\-])(code|otp|pin|token|mfa|2fa|twofactor|two_factor|authcode|verification|verifycode)/i;
const CODE_INPUT_TYPES = new Set(['text', 'tel', 'number', 'password', '']);

// The sentence the portal shows above the box ("We sent a code to •••-1234").
// Display-only, straight back to the admin who is holding the phone.
function challengePrompt(html) {
  // Tags become line breaks, so a heading never runs into the paragraph
  // under it and the first line that mentions a code is the real sentence.
  const lines = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  for (const raw of decodeHtml(lines).split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length > 4 && line.length <= 200 && /\bcodes?\b/i.test(line)) return line;
  }
  return null;
}

// Returns {action, method, field, hidden, csrf, prompt} when `html` is a code
// prompt, otherwise null. `atPath` is where the page came from — the form's
// own action wins, and this is the fallback for action="".
function parseChallenge(html, atPath, cfg = {}) {
  const page = String(html || '');
  if (!page) return null;
  if (/LoginForm\[password\]/.test(page)) return null; // the login form, not a code prompt
  for (const f of formsIn(page)) {
    const ins = inputsIn(f.body);
    if (ins.some((i) => i.type === 'password' && /pass(word|wd)/i.test(i.name))) continue;
    const field = cfg.mfaField
      ? ins.find((i) => i.name === cfg.mfaField)
      : ins.find((i) => i.type !== 'hidden' && CODE_INPUT_TYPES.has(i.type) && CODE_FIELD_RE.test(i.name));
    if (!field) continue;
    const hidden = {};
    for (const i of ins) if (i.type === 'hidden') hidden[i.name] = i.value;
    // "Trust this browser" / "remember me": on. A checkbox posts its own
    // value (browsers default it to "on"); any other control posts "1".
    const options = {};
    for (const i of ins) {
      if (i === field || i.type === 'hidden' || i.type === 'password' || !TRUST_FIELD_RE.test(i.name)) continue;
      if (i.type === 'radio') continue; // no way to know which choice is "yes"
      options[i.name] = i.type === 'checkbox' ? (i.value || 'on') : '1';
    }
    const action = cfg.mfaPath || attrOf(f.attrs, 'action') || atPath || '';
    return {
      action,
      method: (attrOf(f.attrs, 'method') || 'POST').toUpperCase(),
      field: field.name,
      hidden,
      options,
      submit: pickSubmit(f.body),
      csrf: hidden._csrf || csrfFrom(page) || null,
      prompt: challengePrompt(page),
    };
  }
  return null;
}

// The other second-factor screen: "Security setup required — your role
// requires Multi-Factor Authentication". AHGfamily (2026-10) answers a good
// password for a NOT-YET-ENROLLED account by redirecting every page, the
// export included, to /user/mfa-setup — a consent checkbox and AJAX buttons,
// no form at all. It looks signed in (no password field), so without this
// check the stored jar would be treated as live and the export would fail
// on an HTML page. Enrollment means agreeing to SMS terms and choosing a
// phone: a person does that in a browser, never this script.
function isEnrollmentGate(html, url) {
  if (/\bid=["']mfa-is-gated["']/i.test(String(html || ''))) return true;
  try { return /\/(mfa|2fa|two-?factor)[-_]?setup\b/i.test(new URL(url).pathname); } catch { return false; }
}
const failEnrollmentGate = () => fail(8,
  'The portal account must turn on two-step sign-in (text-message codes) before the app can use it. ' +
  'Sign in to the portal in a browser with this account, finish the security setup, then press Connect here.');

// ------------------------------------------------------- session storage ---
// lib/portalSession keeps the signed-in cookie jar (and any parked code
// prompt) in the database, encrypted. It needs a database, and this script
// also runs in contexts that may not have one, so every call is guarded:
// a store that is missing or unhappy degrades to "no stored session", which
// costs one extra sign-in and never fails a fetch.
function sessionStore() {
  try { return require('../lib/portalSession'); } catch { return null; }
}
function tryStore(fn, fallback = null) {
  const store = sessionStore();
  if (!store) return fallback;
  try { return fn(store); } catch { return fallback; }
}

// makeConfig plus the credentials an admin saved in the UI (DB wins over
// .env, exactly as runFetch has always resolved them). Guarded so a context
// without a database still gets a usable config from .env alone.
function configWithSavedCredentials(env = process.env) {
  const cfg = makeConfig(env);
  try {
    const saved = require('../lib/rosterSync').getTlcCredentials();
    if (saved) { cfg.email = saved.email; cfg.password = saved.password; }
  } catch { /* no DB here — env credentials apply */ }
  return cfg;
}

// Is a restored jar still signed in? The login path is the perfect probe:
// a live session is redirected away from it, a dead one gets the form back.
// Returns the page's CSRF token (needed by later XHR calls) or null.
async function probeSession(cfg, jar) {
  const at = cfg.probePath || cfg.loginPath;
  const res = await request(cfg, jar, at);
  if (res.status >= 400) { await res.text().catch(() => {}); return null; }
  const html = await res.text();
  if (/LoginForm\[password\]/.test(html)) return null;    // bounced to the form
  if (parseChallenge(html, at, cfg)) return null;          // half-authenticated
  if (isEnrollmentGate(html, res.url)) return null;        // signed in but fenced off
  return csrfFrom(html);
}

// ----------------------------------------------------------------- login ---
// opts.useStored=false forces a password sign-in (the admin's "Reconnect").
// opts.park=false skips writing the code prompt to the database (tests).
async function login(cfg, jar, opts = {}) {
  // Fast path: reuse the session a human established. This is the whole
  // reason the weekly fetch and the attendance sweep still run unattended
  // on an account that demands a texted code at every password sign-in.
  if (opts.useStored !== false) {
    const lines = tryStore((s) => s.loadCookies(cfg.base));
    if (lines && lines.length) {
      jar.absorbLines(lines);
      let token = null;
      try { token = await probeSession(cfg, jar); } catch { /* network blip — sign in below */ }
      if (token) { tryStore((s) => s.touch()); return token; }
      jar.clear(); // expired: never carry its cookies into a fresh sign-in
    }
  }

  if (!cfg.email || !cfg.password) fail(1, 'TLC_EMAIL / TLC_PASSWORD not set.');

  // …except the trusted-device cookie, which is what lets the portal skip
  // the texted code on this sign-in. It is kept apart from the session
  // (portalSession.loadTrust) precisely so a dead session does not take it
  // with it, and it is only offered back for the same account.
  const trust = tryStore((s) => s.loadTrust(cfg.base, cfg.email));
  if (trust) jar.absorbLines(trust);

  const page = await request(cfg, jar, cfg.loginPath);
  const html = await page.text();
  const token = csrfFrom(html);
  if (!token) fail(2, 'Could not find the _csrf token on the login page — the form may have changed.');

  const body = new URLSearchParams({
    _csrf: token,
    'LoginForm[email]': cfg.email,
    'LoginForm[password]': cfg.password,
    'LoginForm[rememberMe]': '1',
  });
  const res = await request(cfg, jar, cfg.loginPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: cfg.base,
      Referer: cfg.base + cfg.loginPath,
    },
    body: body.toString(),
  });
  const after = await res.text();

  // Second factor. The password was accepted; the portal wants the code it
  // just texted. Park the half-authenticated jar and the form, then STOP —
  // this is never retried on a timer, because every attempt sends the human
  // another text message. A human finishes it in Admin → Roster import.
  const challenge = parseChallenge(after, cfg.loginPath, cfg);
  if (challenge) {
    const parked = opts.park === false ? null : tryStore((s) => s.putChallenge({
      base: cfg.base, cookies: jar.lines(), challenge, prompt: challenge.prompt,
    }));
    const e = new FetchError(6,
      'The portal asked for a sign-in code' + (challenge.prompt ? ` — ${challenge.prompt}` : '') +
      '. Open Admin → Roster import and enter it there; automated syncs resume once the session is connected.');
    e.challenge = challenge;
    e.parked = parked;
    throw e;
  }

  // Success = Yii issues a 302 away from /login (we followed it). Failure =
  // the form re-renders in place with the password field present.
  if (/LoginForm\[password\]/.test(after)) {
    fail(2, 'Login rejected. Check credentials — do NOT retry in a loop, TLC may lock the account.');
  }
  if (isEnrollmentGate(after, res.url)) failEnrollmentGate();
  // A password-only sign-in still produces a session worth keeping: the next
  // run skips the round trip, and on a portal WITH a second factor this is
  // the line that makes "enter the code once" mean once.
  tryStore((s) => s.saveCookies(jar, cfg.base));
  tryStore((s) => s.saveTrust(jar, cfg.base, cfg.email)); // the portal may have renewed it
  // fresh token from the signed-in page for the XHR polling step
  return csrfFrom(after) || token;
}

// Finish a parked sign-in with the code a human typed. Returns the CSRF
// token of the signed-in page; the cookie jar is stored on the way out.
// Throws FetchError(7) with a refreshed .challenge when the code is refused,
// so the admin can retype without starting a new text message.
async function submitChallenge(cfg, jar, challenge, code) {
  const value = String(code || '').trim();
  if (!value) fail(7, 'Enter the code the portal sent.');

  // Field order mirrors the form a browser would send. options/submit are
  // absent on a challenge parked by an older release — then just the code.
  const fields = { ...(challenge.hidden || {}) };
  if (challenge.csrf && !fields._csrf) fields._csrf = challenge.csrf;
  fields[challenge.field] = value;
  Object.assign(fields, challenge.options || {});
  if (challenge.submit && challenge.submit.name) fields[challenge.submit.name] = challenge.submit.value;

  const action = challenge.action || cfg.loginPath;
  const res = await request(cfg, jar, action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: cfg.base,
      Referer: action.startsWith('http') ? action : cfg.base + action,
      ...(fields._csrf ? { 'X-CSRF-Token': fields._csrf } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
  const html = await res.text();
  if (res.status >= 400) {
    fail(7, `The portal refused the code form (status ${res.status}) — start the sign-in again to get a fresh code.`);
  }

  const again = parseChallenge(html, action, cfg);
  if (again) {
    const e = new FetchError(7, 'That code was not accepted — check the digits and try again. ' +
      'If it has expired, start a new sign-in to get a fresh code.');
    e.challenge = again;
    throw e;
  }
  if (/LoginForm\[password\]/.test(html)) {
    fail(2, 'The portal sent us back to the sign-in form — start the sign-in again.');
  }
  if (isEnrollmentGate(html, res.url)) failEnrollmentGate();
  tryStore((s) => s.saveCookies(jar, cfg.base));
  tryStore((s) => s.saveTrust(jar, cfg.base, cfg.email));
  tryStore((s) => s.clearChallenge());
  return csrfFrom(html);
}

// ---------------------------------------------------------------- export ---
async function pollUntilReady(cfg, jar, token) {
  for (let i = 0; i < cfg.pollMax; i++) {
    const res = await request(cfg, jar, cfg.statusPath, {
      method: 'POST',
      headers: {
        'X-CSRF-Token': token,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: cfg.base + '/user/index',
      },
    });
    let json = {};
    try { json = JSON.parse(await res.text()); } catch { /* transient — keep polling */ }
    if (String(json.status).toLowerCase() === 'finished') return true;
    if (i < cfg.pollMax - 1) await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
  return false;
}

async function fetchExport(cfg, jar, token) {
  const first = await request(cfg, jar, cfg.exportPath);
  if (first.status === 200) return Buffer.from(await first.arrayBuffer()); // already warm
  if (first.status !== 503) fail(3, `Unexpected status ${first.status} kicking off the export.`);

  if (!await pollUntilReady(cfg, jar, token)) {
    fail(3, 'Export never reported "finished" within the poll window.');
  }
  const res = await request(cfg, jar, cfg.exportPath);
  if (res.status !== 200) fail(3, `Export not served after "finished" (status ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

// ----------------------------------------------------------- sanity check --
// TLC mislabels the CSV response as spreadsheetml — trust the BYTES, never
// the Content-Type. A real xlsx is a zip and starts "PK\x03\x04".
function detectFormat(buf) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return 'xlsx';
  const head = buf.subarray(0, 300).toString('utf8').replace(/^﻿/, ''); // strip BOM
  if (/^\s*<(!doctype|html)/i.test(head)) return 'html';
  return 'csv';
}

// TLC multi-role accounts resume their LAST-USED role at login, and the
// member export needs a role with member-list access (e.g. Troopmaster).
// We have no verified way to detect/switch the active role over HTTP, so a
// wrong role surfaces as one of the sanity failures below — every message
// points at it as a likely cause.
const ROLE_HINT = ' If the TLC account has multiple roles: TLC signs in under the LAST-USED role, ' +
  'and the export needs one with member-list access (e.g. Troopmaster) — log into TLC in a browser, ' +
  'switch to that role, and try again.';

// Throws FetchError(4) on anything suspicious. prevRows comes from the last
// successful fetch; the guard exists because the realistic failure mode is a
// PARTIAL export (stale TLC filter) parsing cleanly and mass-deactivating
// the roster — not a crash.
function sanityCheck(buf, { prevRows = null, rowTolerance = 0.2 } = {}) {
  if (buf.length < 512) fail(4, `File is only ${buf.length} bytes — almost certainly an error page.`);

  const format = detectFormat(buf);
  if (format === 'html') fail(4, 'Got HTML, not a roster — the session probably expired or the login flow changed.' + ROLE_HINT);

  let rows;
  if (format === 'xlsx') {
    const XLSX = require('xlsx');
    let wb;
    try { wb = XLSX.read(buf, { type: 'buffer' }); }
    catch { fail(4, 'File has the xlsx signature but does not parse as a workbook.'); }
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) fail(4, 'Workbook has no sheets.');
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    // header row located by "Member Number" — the same rule as the importer,
    // so a TLC format change breaks both together, never silently.
    const headerIdx = grid.findIndex((r) => r.some((c) => /member number/i.test(String(c))));
    if (headerIdx < 0) fail(4, 'No "Member Number" header found — export format changed?' + ROLE_HINT);
    rows = grid.length - headerIdx - 1;
  } else {
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    const headerIdx = lines.findIndex((l) => /member number/i.test(l));
    if (headerIdx < 0) fail(4, 'No "Member Number" header found — export format changed?' + ROLE_HINT);
    rows = lines.length - headerIdx - 1;
  }

  if (rows < 5) fail(4, `Only ${rows} data rows — refusing to import.` + ROLE_HINT);

  if (prevRows && rows < prevRows * (1 - rowTolerance)) {
    fail(4, `Row count dropped from ${prevRows} to ${rows} (more than ${Math.round(rowTolerance * 100)}%). ` +
            'Refusing — this would mass-deactivate the roster (stale TLC filter? wrong TLC role?). ' +
            'If the drop is real, upload the export by hand in Admin → Import.' + ROLE_HINT);
  }
  return { rows, format };
}

// ----------------------------------------------------------------- state ---
const readState = (cfg) => {
  try { return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); } catch { return {}; }
};
const writeState = (cfg, patch) => {
  const s = { ...readState(cfg), ...patch };
  fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
  fs.writeFileSync(cfg.stateFile, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
};

// Filename stamp in LOCAL time (honors TZ from .env, falls back to the OS
// zone) — a Saturday-evening fetch must not be named for Sunday's UTC date.
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function pruneOldExports(cfg) {
  const cutoff = Date.now() - cfg.retainDays * 86400000;
  let pruned = 0;
  for (const f of fs.existsSync(cfg.outDir) ? fs.readdirSync(cfg.outDir) : []) {
    const p = path.join(cfg.outDir, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { force: true }); pruned++; }
    } catch { /* ignore */ }
  }
  return pruned;
}

// ------------------------------------------------------------------- run ---
// Returns a result object; throws FetchError on failure. Never logs or
// includes credentials anywhere.
async function runFetch(env = process.env) {
  // Admin-saved credentials (DB, entered in Admin → Import) take precedence
  // over .env; .env stays the fallback.
  const cfg = configWithSavedCredentials(env);
  if (!cfg.enabled) return { skipped: true, reason: 'TLC_ENABLED=false' };

  fs.mkdirSync(cfg.outDir, { recursive: true });

  const jar = new CookieJar();
  const token = await login(cfg, jar);
  const buf = await fetchExport(cfg, jar, token);
  const prev = readState(cfg).last_rows || null;
  const { rows, format } = sanityCheck(buf, { prevRows: prev, rowTolerance: cfg.rowTolerance });

  const outFile = path.join(cfg.outDir, `roster-${localStamp()}.${format}`);
  fs.writeFileSync(outFile, buf, { mode: 0o600 });
  const pruned = pruneOldExports(cfg);

  // Stage the PENDING IMPORT: preview only, replacing any existing pending.
  // The commit decision always belongs to a human in the admin UI.
  let staged;
  try {
    staged = require('../lib/rosterSync').stagePending(outFile, buf, 'sync');
  } catch (e) {
    writeState(cfg, {
      last_run: new Date().toISOString(), last_status: 'failed',
      last_error: `Fetched and saved OK, but staging the pending import failed: ${e.message}`,
    });
    fail(5, `File saved to ${outFile}, but staging the pending import failed: ${e.message}`);
  }

  writeState(cfg, {
    last_run: new Date().toISOString(), last_status: 'ok', last_error: null,
    last_rows: rows, last_file: outFile, last_format: format,
  });

  if (cfg.healthcheckUrl) await fetch(cfg.healthcheckUrl).catch(() => {});
  return { rows, format, file: outFile, pruned, ...staged };
}

// ------------------------------------------------------------------- CLI ---
module.exports = {
  FetchError, makeConfig, CookieJar, request, csrfFrom, decodeHtml,
  attrOf, formsIn, inputsIn, submitsIn, pickSubmit, parseChallenge, challengePrompt,
  isEnrollmentGate, configWithSavedCredentials,
  probeSession, submitChallenge,
  login, pollUntilReady, fetchExport, detectFormat, sanityCheck,
  readState, writeState, pruneOldExports, localStamp, runFetch,
};

if (require.main === module) {
  runFetch().then((r) => {
    if (r.skipped) console.log(`[fetch-roster] skipped: ${r.reason}`);
    else console.log(`[fetch-roster] ok: ${r.file} (${r.rows} rows, ${r.format}` +
      `${r.replaced ? `, replaced ${r.replaced} pending import(s)` : ''})`);
    process.exit(0);
  }).catch((e) => {
    const code = e instanceof FetchError ? e.code : 3;
    // record the failure so the admin UI can show a silently-broken job
    try {
      const cfg = makeConfig();
      if (!(e instanceof FetchError && e.code === 5)) { // 5 already recorded
        writeState(cfg, {
          last_run: new Date().toISOString(),
          // A code prompt is not a broken job — it is a job waiting on a
          // human, and the admin page says so instead of crying "failed".
          last_status: e instanceof FetchError && e.code === 6 ? 'code_required' : 'failed',
          last_error: e instanceof FetchError ? e.message : `Unexpected: ${e.message}`,
        });
      }
    } catch { /* state write is best-effort */ }
    console.error('[fetch-roster] ' + (e instanceof FetchError ? e.message : (e.stack || String(e))));
    process.exit(code);
  });
}
