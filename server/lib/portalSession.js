'use strict';
/**
 * portalSession.js — portal sign-in state that survives a restart: the
 * signed-in cookie jar, plus a code challenge waiting on a human.
 *
 * WHY THIS EXISTS. Trail Life Connect (and AHGfamily on the same platform)
 * now require a second factor — "you'll enter your password and a code sent
 * to your phone at every sign-in". Every automated portal job goes through
 * one function, scripts/fetch-roster.js login(): the weekly roster fetch,
 * the attendance write-back sweep, the permission-form sync. If each of
 * those posted the password on its own schedule, each would strand on a
 * code prompt with nobody there to answer it.
 *
 * The design is CONNECT ONCE, MACHINE CONTINUES:
 *   1. A human presses "Connect" in Admin → Import (or a job runs, finds no
 *      usable session, and parks a challenge for the next human).
 *   2. The server posts the password; the portal answers with a code form.
 *      That form — action, field name, hidden inputs — and the
 *      half-authenticated cookie jar are parked here for CHALLENGE_TTL_MS.
 *   3. The human types the code off their phone into the admin page; the
 *      server finishes the sign-in and stores the resulting cookies.
 *   4. Every later job reuses those cookies and never sees a code prompt
 *      until the portal itself expires the session.
 *
 * DELIBERATELY NOT BUILT: automatic code retrieval (an email/SMS relay that
 * reads the code and types it back). An unattended relay collapses two
 * factors into one on an account that reaches youth records — the machine
 * would hold both the password and the code path. A human typing six digits
 * once per session lifetime is the entire security value of the second
 * factor, and it is the one part of the flow that must stay human.
 *
 * AT REST: session cookies and the parked challenge are credentials in
 * every practical sense, so both are AES-256-GCM encrypted through
 * lib/credCrypto exactly like the portal password — database snapshots and
 * the nightly backups hold only ciphertext. Every read tolerates a missing
 * or rotated CRED_KEY by reporting "not connected" rather than throwing;
 * the worst case is one extra sign-in.
 */
const fs = require('fs');
const { db } = require('../db');
const credCrypto = require('./credCrypto');

const SESSION_KEY = 'portal_session';
const CHALLENGE_KEY = 'portal_challenge';
const CHALLENGE_TTL_MS = 15 * 60 * 1000;

// ------------------------------------------------------------- meta i/o ---
function readMeta(key) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}
function writeMeta(key, obj) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(obj));
}
const dropMeta = (key) => db.prepare('DELETE FROM meta WHERE key = ?').run(key).changes > 0;

// Encrypt/decrypt an arbitrary JSON payload. Returns null (never throws) when
// no key exists or the ciphertext no longer authenticates.
function seal(obj) {
  // Reuse the key that already protects the portal password. If none exists
  // yet, generate one exactly as saving credentials does — but only when
  // there is an .env to keep it in, so a bare checkout (tests, CI) never
  // grows a stray file just because a session could have been cached.
  if (!credCrypto.loadKey()) {
    if (!fs.existsSync(credCrypto.ENV_PATH)) throw new Error('no CRED_KEY, and no .env file to store one in');
    credCrypto.ensureKey();
  }
  return credCrypto.encrypt(JSON.stringify(obj));
}
function unseal(box) {
  if (!box) return null;
  let raw;
  try { raw = credCrypto.decrypt(box); } catch { return null; }
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ------------------------------------------------------ signed-in session --
// Cookies are stored as plain "name=value" lines, the shape CookieJar
// .absorbLines() already takes, so restoring is jar.absorbLines(lines).
function saveCookies(jar, base) {
  const lines = [...jar.map].map(([k, v]) => `${k}=${v}`);
  if (!lines.length) return null;
  const now = new Date().toISOString();
  const prev = readMeta(SESSION_KEY) || {};
  try {
    writeMeta(SESSION_KEY, {
      base, saved_at: now, last_ok_at: now,
      connected_at: prev.base === base && prev.connected_at ? prev.connected_at : now,
      box: seal({ lines }),
    });
  } catch (e) {
    // No CRED_KEY and no writable .env: keep working, just without the
    // persistent session (every job then needs its own code).
    console.error('[portalSession] could not store the portal session:', e.message);
    return null;
  }
  return now;
}

// Returns the stored cookie lines for this base, or null.
function loadCookies(base) {
  const s = readMeta(SESSION_KEY);
  if (!s || (base && s.base && s.base !== base)) return null;
  const payload = unseal(s.box);
  return payload && Array.isArray(payload.lines) && payload.lines.length ? payload.lines : null;
}

// Called after a stored session is proven still good.
function touch() {
  const s = readMeta(SESSION_KEY);
  if (!s) return null;
  const now = new Date().toISOString();
  writeMeta(SESSION_KEY, { ...s, last_ok_at: now });
  return now;
}

const clearSession = () => ({ cleared: dropMeta(SESSION_KEY) });

// Never includes cookies — this is what the admin page renders.
function sessionInfo() {
  const s = readMeta(SESSION_KEY);
  if (!s) return { connected: false, base: null, connected_at: null, saved_at: null, last_ok_at: null, readable: false };
  const readable = !!unseal(s.box);
  return {
    connected: readable, readable,
    base: s.base || null,
    connected_at: s.connected_at || s.saved_at || null,
    saved_at: s.saved_at || null,
    last_ok_at: s.last_ok_at || null,
  };
}

// -------------------------------------------------------- parked challenge --
// One at a time: a newer sign-in attempt replaces an older prompt, because
// the code the portal just texted is the only one that will work.
function putChallenge({ base, cookies, challenge, prompt }) {
  const id = require('crypto').randomBytes(9).toString('base64url');
  const created_at = new Date().toISOString();
  const expires_at = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  try {
    writeMeta(CHALLENGE_KEY, {
      id, base, created_at, expires_at,
      prompt: prompt || null,
      box: seal({ cookies, challenge }),
    });
  } catch (e) {
    console.error('[portalSession] could not park the sign-in challenge:', e.message);
    return null;
  }
  return { id, created_at, expires_at, prompt: prompt || null };
}

// Full record including cookies + form details. Expired or unreadable → null.
function getChallenge(id) {
  const c = readMeta(CHALLENGE_KEY);
  if (!c) return null;
  if (id && c.id !== id) return null;
  if (Date.parse(c.expires_at) < Date.now()) { dropMeta(CHALLENGE_KEY); return null; }
  const payload = unseal(c.box);
  if (!payload) return null;
  return { id: c.id, base: c.base, created_at: c.created_at, expires_at: c.expires_at, prompt: c.prompt, ...payload };
}

// Safe summary for the admin page (no cookies, no form internals).
function challengeInfo() {
  const c = readMeta(CHALLENGE_KEY);
  if (!c) return null;
  if (Date.parse(c.expires_at) < Date.now()) { dropMeta(CHALLENGE_KEY); return null; }
  return { id: c.id, created_at: c.created_at, expires_at: c.expires_at, prompt: c.prompt || null };
}

const clearChallenge = () => ({ cleared: dropMeta(CHALLENGE_KEY) });

module.exports = {
  CHALLENGE_TTL_MS,
  saveCookies, loadCookies, touch, clearSession, sessionInfo,
  putChallenge, getChallenge, challengeInfo, clearChallenge,
};
