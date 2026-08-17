'use strict';
// TLC attendance write-back (docs/12-attendance-writeback.md).
//
// Check-ins enqueue rows in tlc_attendance_push; a background sweep (or the
// admin "Push now" button) logs into Trail Life Connect and marks each
// person Attended on the mapped TLC event via the same endpoints the Track
// Attendance page uses (captured live 2026-08-11):
//
//   POST /calendar/attendance-user-list   → HTML fragment (hashids + state)
//   POST /calendar/toggle-attendance      → userId, eventId, value=1,
//                                           use_lesson_plans; empty 200 = ok
//
// Non-negotiables (mirroring the roster-sync spec):
//   - the app only ever sends value=1 — it NEVER un-marks attendance on TLC
//   - a failed login STOPS the sweep until credentials are re-saved or a
//     human presses "Push now" (no retry loop — TLC may lock the account)
//   - disabled by default; global switch + per-event override, both visible
//     in the admin UI, and every push attempt is logged per person
//   - credentials never appear in logs or errors
//
// Login/CSRF/cookie primitives are reused from scripts/fetch-roster.js — the
// exact code that has been logging into TLC weekly since July 2026.

const { db } = require('../db');

// Lazy-required so tests can stub pieces; fetch-roster only runs its CLI
// when it is the main module.
const fetcher = () => require('../scripts/fetch-roster');
const rosterSync = () => require('./rosterSync');

// ----------------------------------------------------------- settings ------
// meta key 'tlc_attendance' — {enabled: 0|1, use_lesson_plans: 0|1}.
// Disabled by default: existing installs behave exactly as before upgrade.
const SETTINGS_KEY = 'tlc_attendance';
const STATE_KEY = 'tlc_attendance_state';

function readMeta(key, fallback) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return { ...fallback, ...JSON.parse(row.value) }; } catch { return fallback; }
}
function writeMeta(key, obj) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(obj));
}

const getSettings = () => readMeta(SETTINGS_KEY, { enabled: 0, use_lesson_plans: 1 });
function saveSettings(patch) {
  const s = getSettings();
  if ('enabled' in patch) s.enabled = patch.enabled ? 1 : 0;
  if ('use_lesson_plans' in patch) s.use_lesson_plans = patch.use_lesson_plans ? 1 : 0;
  writeMeta(SETTINGS_KEY, s);
  return s;
}

const getState = () => readMeta(STATE_KEY, {
  last_run: null, last_status: null, last_error: null, auth_failed_at: null,
});
const patchState = (p) => { const s = { ...getState(), ...p }; writeMeta(STATE_KEY, s); return s; };
// re-saving credentials clears the auth latch (called from the admin route)
const clearAuthFailure = () => patchState({ auth_failed_at: null });

// ------------------------------------------------------- event mapping -----
// TLC iCal UIDs are <16 chars>-<12-char event hashid>-<15 chars>; verified
// against /databuilder/search-events for events across 2024-2026. Be strict
// enough to never mis-parse a non-TLC UID (manual events, other feeds).
function tlcEventIdFromUid(uid) {
  const m = /^([a-z0-9]{10,24})-([a-z0-9]{10,14})-([a-z0-9]{10,24})$/i.exec(String(uid || '').trim());
  return m ? m[2] : null;
}

// Resolve (and cache) the TLC event hashid for an app event row.
function resolveTlcEventId(event) {
  if (!event) return null;
  if (event.tlc_event_id) return event.tlc_event_id;
  const id = event.source === 'ical' ? tlcEventIdFromUid(event.ical_uid) : null;
  if (id) db.prepare('UPDATE event SET tlc_event_id = ? WHERE id = ?').run(id, event.id);
  return id;
}

// Should this event push? Per-event override wins; NULL follows the global.
function pushEnabledFor(event, settings = getSettings()) {
  if (event.tlc_push === 0) return false;
  if (event.tlc_push === 1) return true;
  return !!settings.enabled;
}

// --------------------------------------------------------------- queue -----
// Called from every SIGN-OUT path AFTER the txn commits (kiosk sign-out,
// admin close, SMS pickup confirm) — attendance is recorded when the visit
// is over, so the "completed planned requirements" answer is known.
// `entries` are person ids or {person_id, advancement}; advancement defaults
// to true and is ANDed with the global advancement setting: unchecking the
// kiosk box pushes attendance-only (use_lesson_plans=0) for that person,
// while everyone else still gets advancement credit. Must never throw into
// the kiosk flow — callers wrap in try/catch, and this only touches SQLite.
function enqueue(eventId, entries) {
  const event = db.prepare('SELECT * FROM event WHERE id = ?').get(eventId);
  if (!event) return { queued: 0, reason: 'no such event' };
  const settings = getSettings();
  if (!pushEnabledFor(event, settings)) return { queued: 0, reason: 'push disabled' };
  const tlcEventId = resolveTlcEventId(event);
  if (!tlcEventId) return { queued: 0, reason: 'event has no TLC link' };

  const ins = db.prepare(
    `INSERT INTO tlc_attendance_push (event_id, person_id, tlc_event_id, use_lesson_plans)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id, person_id) DO NOTHING`);
  let queued = 0;
  const run = db.transaction(() => {
    for (const e of entries) {
      const pid = typeof e === 'object' ? e.person_id : e;
      const advancement = typeof e === 'object' ? e.advancement !== false : true;
      const p = db.prepare(`SELECT id, status FROM person WHERE id = ?`).get(pid);
      if (!p || p.status === 'visitor') continue; // visitors don't exist on TLC
      const lessons = settings.use_lesson_plans && advancement ? 1 : 0;
      queued += ins.run(eventId, pid, tlcEventId, lessons).changes;
    }
  });
  run();
  return { queued, tlc_event_id: tlcEventId };
}

function queueSummary() {
  const g = (st) => db.prepare('SELECT COUNT(*) c FROM tlc_attendance_push WHERE status = ?').get(st).c;
  return { pending: g('pending'), sent: g('sent'), failed: g('failed') };
}

function recentRows(limit = 30) {
  return db.prepare(
    `SELECT q.id, q.status, q.detail, q.attempts, q.created_at, q.sent_at,
            q.tlc_event_id, q.tlc_user_id,
            p.first_name || ' ' || p.last_name AS person_name,
            e.title AS event_title, e.start_at AS event_start
       FROM tlc_attendance_push q
       JOIN person p ON p.id = q.person_id
       JOIN event e  ON e.id = q.event_id
      ORDER BY q.id DESC LIMIT ?`).all(limit);
}

function retryFailed() {
  return { retried: db.prepare(
    `UPDATE tlc_attendance_push SET status = 'pending', detail = NULL WHERE status = 'failed'`
  ).run().changes };
}

// ------------------------------------------------------ name matching ------
const normName = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
const nameKey = (last, first) => `${normName(last)},${normName(first)}`;

// Parse the attendance-user-list HTML fragment into
//   { byHash: Map<userHash, {name, attended}>, byName: Map<nameKey, userHash|'AMBIGUOUS'> }
// Two independent sources are cross-checked: the profile anchors
// (/profile/<hash>?...>Last, First</a>) give hash→name; the checkbox-x
// inputs (id="<userHash>-<eventHash>-attended" value="1|0|") give state.
function parseUserList(html, tlcEventId) {
  const byHash = new Map();
  const anchorRe = /<a[^>]+href="\/profile\/([a-z0-9]+)(?:\?[^"]*)?"[^>]*>([^<]+)<\/a>/gi;
  for (let m; (m = anchorRe.exec(html));) {
    const name = m[2].trim();
    if (!name || !name.includes(',')) continue; // nav links etc.
    byHash.set(m[1], { name, attended: null });
  }
  const inputRe = new RegExp(
    `<input\\b[^>]*\\bid="([a-z0-9]+)-${tlcEventId}-attended"[^>]*>`, 'gi');
  for (let m; (m = inputRe.exec(html));) {
    const valm = /value="([^"]*)"/i.exec(m[0]);
    const attended = valm && valm[1] === '1' ? 1 : 0;
    const e = byHash.get(m[1]);
    if (e) e.attended = attended;
    else byHash.set(m[1], { name: null, attended });
  }
  const byName = new Map();
  for (const [hash, e] of byHash) {
    if (!e.name) continue;
    const ci = e.name.indexOf(',');
    const key = nameKey(e.name.slice(0, ci), e.name.slice(ci + 1));
    byName.set(key, byName.has(key) ? 'AMBIGUOUS' : hash);
  }
  return { byHash, byName };
}

// Find the TLC hashid for an app person: cached id first, then exact
// "Last, First" match, then nickname. Ambiguity is an explicit failure —
// never guess between two people with the same name.
function matchPerson(person, list) {
  // A stored id is the operator's explicit answer, so it ends the search
  // either way. Falling through to the name match when it is missing from
  // this event's list would silently hand a same-named relative's hashid
  // to someone the event never invited — the exact wrong-person write the
  // mapping was set to prevent. Absent means "not on this roster".
  if (person.tlc_user_id) {
    return list.byHash.has(person.tlc_user_id)
      ? { hash: person.tlc_user_id }
      : { error: `"${person.last_name}, ${person.first_name}" has a TLC id set but is not on this event's roster.` };
  }
  const keys = [nameKey(person.last_name, person.first_name)];
  if (person.nickname) keys.push(nameKey(person.last_name, person.nickname));
  for (const k of keys) {
    const hit = list.byName.get(k);
    if (hit === 'AMBIGUOUS') return { error: `More than one "${person.last_name}, ${person.first_name}" on the TLC list — set the TLC id by hand.` };
    if (hit) return { hash: hit, learned: true };
  }
  return { error: `No TLC roster entry matches "${person.last_name}, ${person.first_name}".` };
}

// ---------------------------------------------------------- TLC calls ------
// A logged-in TLC session built on fetch-roster's proven primitives.
async function tlcSession(env = process.env) {
  const F = fetcher();
  const cfg = F.makeConfig(env);
  try {
    const saved = rosterSync().getTlcCredentials();
    if (saved) { cfg.email = saved.email; cfg.password = saved.password; }
  } catch { /* env credentials apply */ }
  const jar = new F.CookieJar();
  const token = await F.login(cfg, jar); // throws FetchError(2) on rejection
  return { cfg, jar, token };
}

const ajaxHeaders = (s) => ({
  'X-CSRF-Token': s.token,
  'X-Requested-With': 'XMLHttpRequest',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Accept: '*/*',
  Origin: s.cfg.base,
  Referer: s.cfg.base + '/attendance',
});

async function fetchUserList(s, tlcEventId) {
  const F = fetcher();
  const body = new URLSearchParams({
    patrol: '', eventId: tlcEventId, sortBy: 'alphabetical', rsvpOnly: '0', lockAttended: '0',
  });
  const res = await F.request(s.cfg, s.jar, '/calendar/attendance-user-list', {
    method: 'POST', headers: ajaxHeaders(s), body: body.toString(),
  });
  const html = await res.text();
  if (res.status !== 200 || /LoginForm\[password\]/.test(html)) {
    throw new Error(`TLC user list failed for event ${tlcEventId} (status ${res.status}).`);
  }
  return parseUserList(html, tlcEventId);
}

async function toggleAttendance(s, { userId, eventId, useLessonPlans }) {
  const F = fetcher();
  const body = new URLSearchParams({
    userId, eventId, value: '1', use_lesson_plans: useLessonPlans ? '1' : '0',
  });
  const res = await F.request(s.cfg, s.jar, '/calendar/toggle-attendance', {
    method: 'POST', headers: ajaxHeaders(s), body: body.toString(),
  });
  await res.text(); // success is an EMPTY 200 — nothing to parse
  if (res.status !== 200) throw new Error(`toggle-attendance returned status ${res.status}.`);
}

// ------------------------------------------------- badge-derived ids -------
// Badge QR payloads are "<memberID> | <TLC user hashid>" — TLC prints its
// own hashid on every membership card, so a linked badge already tells us
// the mapping the write-back needs. Fill-when-empty only: a hand-set id is
// never overwritten, and an id another person holds is never duplicated.
function tlcIdFromBadge(code) {
  const parts = String(code || '').split('|');
  if (parts.length < 2) return null;
  const token = parts[1].trim();
  return /^[a-z0-9]{8,16}$/i.test(token) ? token : null;
}

// Set person.tlc_user_id from a badge payload if it is empty and the id is
// free. Returns true when a value was written.
function adoptBadgeTlcId(personId, code) {
  const id = tlcIdFromBadge(code);
  if (!id) return false;
  const p = db.prepare('SELECT id, tlc_user_id FROM person WHERE id = ?').get(personId);
  if (!p || p.tlc_user_id) return false;
  const holder = db.prepare(
    `SELECT id FROM person WHERE tlc_user_id = ? AND id != ? AND status != 'merged'`).get(id, personId);
  if (holder) return false;
  db.prepare(`UPDATE person SET tlc_user_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(id, personId);
  return true;
}

// One-time-ish sweep over everyone with a linked badge but no TLC id —
// idempotent and cheap, run at every server start so an upgrade backfills
// the whole troop without anyone rescanning.
function backfillFromBadges() {
  let filled = 0;
  for (const p of db.prepare(
    `SELECT id, badge_code FROM person
      WHERE badge_code IS NOT NULL AND tlc_user_id IS NULL AND status != 'merged'`).all()) {
    if (adoptBadgeTlcId(p.id, p.badge_code)) filled++;
  }
  if (filled) console.log(`[tlc-attendance] backfilled ${filled} TLC id(s) from linked badges`);
  return { filled };
}

// ------------------------------------------------------- id lookup ---------
// Admin helper: read one TLC event roster and return every entry sharing the
// person's last name, so the operator can pick the right hashid instead of
// running SQL on the server. Exact-name candidates are flagged, and so is
// any hashid already assigned to a different app person (catches the
// youth/parent namesake traps this mapping exists to solve).
async function lookupCandidates({ personId, eventId = null, env = process.env }) {
  const person = db.prepare('SELECT * FROM person WHERE id = ?').get(personId);
  if (!person) { const e = new Error('No such person.'); e.code = 404; throw e; }

  let event = eventId ? db.prepare('SELECT * FROM event WHERE id = ?').get(eventId) : null;
  if (!event) {
    // default: the TLC-linked event nearest to now — most likely to carry a
    // full troop roster and to be the one the operator is thinking about
    for (const r of db.prepare(
      `SELECT * FROM event ORDER BY ABS(julianday(start_at) - julianday('now')) LIMIT 200`).all()) {
      if (resolveTlcEventId(r)) { event = r; break; }
    }
  }
  const tlcEventId = event && resolveTlcEventId(event);
  if (!tlcEventId) {
    const e = new Error('No TLC-linked event to read a roster from — pick one on the calendar first.');
    e.code = 422; throw e;
  }

  const session = await tlcSession(env);
  const list = await fetchUserList(session, tlcEventId);
  const lastKey = normName(person.last_name);
  const exactKeys = new Set([nameKey(person.last_name, person.first_name)]);
  if (person.nickname) exactKeys.add(nameKey(person.last_name, person.nickname));

  const candidates = [];
  for (const [hash, entry] of list.byHash) {
    if (!entry.name) continue;
    const ci = entry.name.indexOf(',');
    if (normName(entry.name.slice(0, ci)) !== lastKey) continue;
    const key = nameKey(entry.name.slice(0, ci), entry.name.slice(ci + 1));
    const assigned = db.prepare(
      `SELECT first_name, last_name, is_youth FROM person
        WHERE tlc_user_id = ? AND id != ? AND status != 'merged'`).get(hash, person.id);
    candidates.push({
      hash,
      name: entry.name,
      exact: exactKeys.has(key),
      current: person.tlc_user_id === hash,
      assigned_to: assigned
        ? `${assigned.first_name} ${assigned.last_name} (${assigned.is_youth ? 'youth' : 'adult'})`
        : null,
    });
  }
  candidates.sort((a, b) => (b.exact - a.exact) || a.name.localeCompare(b.name));
  return {
    event: { id: event.id, title: event.title, start_at: event.start_at },
    candidates,
  };
}

// ----------------------------------------------------------- the push ------
let running = false;
const isRunning = () => running;

// Process every pending row. One login per run; one user-list fetch per
// distinct TLC event; verify-before-write (already-attended rows are recorded
// as sent without touching TLC). Returns a summary for the admin UI.
async function runPush({ manual = false, env = process.env } = {}) {
  if (running) return { skipped: true, reason: 'A push is already running.' };
  const state = getState();
  if (!manual && state.auth_failed_at) {
    return { skipped: true, reason: 'Paused after a failed TLC login — re-save credentials or use Push now.' };
  }
  const pending = db.prepare(`SELECT * FROM tlc_attendance_push WHERE status = 'pending' ORDER BY id`).all();
  if (!pending.length) return { skipped: true, reason: 'Nothing pending.' };

  running = true;
  const summary = { sent: 0, already: 0, failed: 0 };
  const mark = db.prepare(
    `UPDATE tlc_attendance_push
        SET status = ?, detail = ?, attempts = attempts + 1,
            tlc_user_id = COALESCE(?, tlc_user_id),
            sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END
      WHERE id = ?`);
  try {
    let session;
    try {
      session = await tlcSession(env);
      if (state.auth_failed_at) patchState({ auth_failed_at: null }); // login works again
    } catch (e) {
      // Auth latch: NEVER retry a rejected login on a timer. code 2 = login
      // rejected (fetch-roster semantics); anything else is transient network.
      const auth = e && e.code === 2;
      patchState({
        last_run: new Date().toISOString(), last_status: 'failed',
        last_error: e.message, ...(auth ? { auth_failed_at: new Date().toISOString() } : {}),
      });
      return { failed_login: true, auth_latched: !!auth, error: e.message };
    }

    const lists = new Map(); // tlcEventId → parsed user list (one fetch each)
    for (const row of pending) {
      try {
        if (!lists.has(row.tlc_event_id)) {
          lists.set(row.tlc_event_id, await fetchUserList(session, row.tlc_event_id));
        }
        const list = lists.get(row.tlc_event_id);
        const person = db.prepare('SELECT * FROM person WHERE id = ?').get(row.person_id);
        const m = matchPerson(person, list);
        if (m.error) { mark.run('failed', m.error, null, 'failed', row.id); summary.failed++; continue; }
        if (m.learned) {
          db.prepare('UPDATE person SET tlc_user_id = ? WHERE id = ?').run(m.hash, person.id);
        }
        const entry = list.byHash.get(m.hash);
        if (entry && entry.attended === 1) {
          mark.run('sent', 'already marked on TLC', m.hash, 'sent', row.id);
          summary.already++; continue;
        }
        await toggleAttendance(session, {
          userId: m.hash, eventId: row.tlc_event_id, useLessonPlans: row.use_lesson_plans,
        });
        mark.run('sent', null, m.hash, 'sent', row.id);
        summary.sent++;
      } catch (e) {
        mark.run('failed', e.message, null, 'failed', row.id);
        summary.failed++;
      }
    }
    patchState({
      last_run: new Date().toISOString(),
      last_status: summary.failed ? 'partial' : 'ok',
      last_error: summary.failed ? `${summary.failed} row(s) failed — see the log.` : null,
    });
    return summary;
  } finally {
    running = false;
  }
}

// ------------------------------------------------------------- sweep -------
// Every 10 minutes: quietly push whatever is pending. All the guards live in
// runPush (disabled → nothing enqueues; auth latch; single-flight), so the
// timer itself stays dumb. unref()'d — never keeps tests or one-offs alive.
function scheduleSweep(intervalMs = 10 * 60 * 1000) {
  const t = setInterval(() => {
    runPush().catch((e) => console.error('[tlc-attendance] sweep failed:', e.message));
  }, intervalMs);
  t.unref();
  return t;
}

module.exports = {
  getSettings, saveSettings, getState, clearAuthFailure,
  tlcEventIdFromUid, resolveTlcEventId, pushEnabledFor,
  enqueue, queueSummary, recentRows, retryFailed, lookupCandidates,
  tlcIdFromBadge, adoptBadgeTlcId, backfillFromBadges,
  normName, nameKey, parseUserList, matchPerson,
  tlcSession, fetchUserList, toggleAttendance,
  runPush, isRunning, scheduleSweep,
};
