'use strict';
const portal = require('./portal');
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
const tlcPlans = require('./tlcPlans');

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

// plan_check — the activity-plan guard (lib/tlcPlans.js):
//   off   exactly the pre-guard behaviour; the plan endpoint is never read
//   warn  read the plan and record what would/would not be credited, push anyway
//   hold  park a push whose advancement would not land, so the one-and-only
//         chance to record it survives until the plan is fixed on TLC
// hold_release_hours — after this long a held row pushes anyway, so the
// ATTENDANCE record is never lost; the forgone advancement is written to
// tlc_advancement_skipped and stays there until a human verifies the fix.
const PLAN_CHECK_MODES = ['off', 'warn', 'hold'];
const getSettings = () => readMeta(SETTINGS_KEY, {
  enabled: 0, use_lesson_plans: 1, plan_check: 'off', hold_release_hours: 72,
});
function saveSettings(patch) {
  const s = getSettings();
  if ('enabled' in patch) s.enabled = patch.enabled ? 1 : 0;
  if ('use_lesson_plans' in patch) s.use_lesson_plans = patch.use_lesson_plans ? 1 : 0;
  if ('plan_check' in patch) {
    s.plan_check = PLAN_CHECK_MODES.includes(patch.plan_check) ? patch.plan_check : 'off';
  }
  if ('hold_release_hours' in patch) {
    const n = Number(patch.hold_release_hours);
    s.hold_release_hours = Number.isFinite(n) && n >= 1 && n <= 24 * 30 ? Math.round(n) : 72;
  }
  writeMeta(SETTINGS_KEY, s);
  return s;
}

const getState = () => readMeta(STATE_KEY, {
  last_run: null, last_status: null, last_error: null, auth_failed_at: null,
  // set when the portal wanted a sign-in code: the sweep waits for a human
  // rather than re-posting the password (every attempt texts another code)
  code_required_at: null,
  // last time a run existed only to re-check held rows — throttles that
  // polling to HOLD_POLL_MS instead of every sweep
  last_hold_poll: null,
  // plan problems found on the last run, keyed by event title
  plan_warnings: [],
});
const patchState = (p) => { const s = { ...getState(), ...p }; writeMeta(STATE_KEY, s); return s; };
// re-saving credentials clears the auth latch (called from the admin route)
const clearAuthFailure = () => patchState({ auth_failed_at: null, code_required_at: null });

// ------------------------------------------------------- event mapping -----
// Portal iCal UIDs are three dash-separated segments with the 12-char event
// hashid in the MIDDLE. Two shapes seen on the same platform:
//   Trail Life Connect: <16 alphanumerics>-<12 hashid>-<15 alphanumerics>
//     (verified against /databuilder/search-events for events across 2024-2026)
//   AHGfamily:          <9 letters>-<12 hashid>-<YYYYMMDDTHHMMSS> (15 chars)
//     (found 2026-09-07: the 10-char floor on the head rejected every AHG UID,
//     so no AHG event could ever link)
// The head accepts 9–24; the middle group stays {10,14} — it is the guard
// against mis-parsing a manual event or a foreign feed's UID.
function tlcEventIdFromUid(uid) {
  const m = /^([a-z0-9]{9,24})-([a-z0-9]{10,14})-([a-z0-9]{10,24})$/i.exec(String(uid || '').trim());
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
  if (!tlcEventId) return { queued: 0, reason: portal.t('event has no TLC link') };

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
  // pre-migration installs have neither the columns nor the table
  const count = (sql) => { try { return db.prepare(sql).get().c; } catch { return 0; } };
  const held = count(
    `SELECT COUNT(*) c FROM tlc_attendance_push WHERE status = 'pending' AND hold_reason IS NOT NULL`);
  return {
    // held rows stay 'pending' so the sweep re-evaluates them for free —
    // report them separately so the UI never calls them merely queued
    pending: g('pending') - held, held, sent: g('sent'), failed: g('failed'),
    skipped_open: count(
      'SELECT COUNT(*) c FROM tlc_advancement_skipped WHERE acknowledged_at IS NULL'),
  };
}

function recentRows(limit = 30, from = null, to = null) {
  return db.prepare(
    `SELECT q.id, q.status, q.detail, q.attempts, q.created_at, q.sent_at,
            q.tlc_event_id, q.tlc_user_id, q.hold_reason, q.hold_since,
            p.first_name || ' ' || p.last_name AS person_name,
            e.title AS event_title, e.start_at AS event_start
       FROM tlc_attendance_push q
       JOIN person p ON p.id = q.person_id
       JOIN event e  ON e.id = q.event_id
      WHERE (? IS NULL OR datetime(q.created_at) >= datetime(?))
        AND (? IS NULL OR datetime(q.created_at) <= datetime(?))
      ORDER BY q.id DESC LIMIT ?`)
    .all(from || null, from || null, to || null, to || null, limit);
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

// The few entities the portal's HTML encoder emits inside a name, plus the
// &nbsp; padding the grid layout wraps around it.
const decodeText = (s) => String(s || '')
  .replace(/&nbsp;| /g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

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
  // The sibling portal on the same platform (AHGfamily) renders the same
  // fragment as a CSS grid with NO profile anchors: the name is plain text in
  // the cell right before the checkbox cell (adults get an <img> avatar in
  // that cell first) —
  //   <div style="grid-column: 1">[<img …>] &nbsp;&nbsp;Last, First&nbsp;</div>
  //   <div …><input … id="<userHash>-<eventHash>-attended" …></div>
  // Without this pass every name there is unknown and nobody can be matched.
  const gridRe = new RegExp(
    `<div\\b[^>]*grid-column:\\s*1\\b[^>]*>((?:[^<]|<(?!\\/div>)[^>]*>)*)<\\/div>\\s*<div\\b[^>]*>\\s*` +
    `<input\\b[^>]*\\bid="([a-z0-9]+)-${tlcEventId}-attended"`, 'gi');
  for (let m; (m = gridRe.exec(html));) {
    const name = decodeText(m[1].replace(/<[^>]*>/g, ' '));
    if (!name || !name.includes(',')) continue;
    const e = byHash.get(m[2]);
    if (e) { if (!e.name) e.name = name; } else byHash.set(m[2], { name, attended: null });
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
  // `$.users` rides along in the same fragment: youth only, each with the
  // level and patrol an activity plan is matched against. Free input for the
  // plan guard — no extra request.
  return { byHash, byName, users: tlcPlans.parseUsers(html) };
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
      : { error: portal.t(`"${person.last_name}, ${person.first_name}" has a TLC id set but is not on this event's roster.`) };
  }
  const keys = [nameKey(person.last_name, person.first_name)];
  if (person.nickname) keys.push(nameKey(person.last_name, person.nickname));
  for (const k of keys) {
    const hit = list.byName.get(k);
    if (hit === 'AMBIGUOUS') return { error: portal.t(`More than one "${person.last_name}, ${person.first_name}" on the TLC list — set the TLC id by hand.`) };
    if (hit) return { hash: hit, learned: true };
  }
  return { error: portal.t(`No TLC roster entry matches "${person.last_name}, ${person.first_name}".`) };
}

// ---------------------------------------------------------- TLC calls ------
// A logged-in TLC session built on fetch-roster's proven primitives.
async function tlcSession(env = process.env) {
  const F = fetcher();
  const cfg = F.configWithSavedCredentials(env);
  const jar = new F.CookieJar();
  // Reuses the stored portal session when there is one, so a portal that
  // demands a texted code at every password sign-in does not stop the sweep.
  // Throws FetchError(2) when rejected, FetchError(6) when a code is needed.
  const token = await F.login(cfg, jar);
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
    throw new Error(portal.t(`TLC user list failed for event ${tlcEventId} (status ${res.status}).`));
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
    const e = new Error(portal.t('No TLC-linked event to read a roster from — pick one on the calendar first.'));
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

// ------------------------------------------------------- the plan guard ----
// A held row keeps status 'pending' so every sweep re-evaluates it and sends
// it the instant the plan is corrected on TLC — no new status value, no
// rebuild of the CHECK constraint, no separate retry path.
const HOLD_POLL_MS = 30 * 60 * 1000; // held-only runs poll this often, not every sweep

// Prepared lazily, never at module load: server/index.js is required by the
// first-run setup flow against a database that has had no migrations applied,
// and a top-level db.prepare() of these columns would throw there.
const holdRow = (reason, id) => db.prepare(
  `UPDATE tlc_attendance_push
      SET hold_reason = ?, hold_since = COALESCE(hold_since, datetime('now'))
    WHERE id = ?`).run(reason, id);
const unholdRow = (id) => db.prepare(
  'UPDATE tlc_attendance_push SET hold_reason = NULL, hold_since = NULL WHERE id = ?').run(id);
const insSkipped = (...args) => db.prepare(
  `INSERT INTO tlc_advancement_skipped
     (push_id, event_id, person_id, tlc_event_id, tlc_user_id, reason, plan_snapshot, held_since)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(event_id, person_id) DO UPDATE SET
     reason = excluded.reason, plan_snapshot = excluded.plan_snapshot,
     released_at = datetime('now'),
     verified_at = NULL, verify_result = NULL, verify_detail = NULL,
     acknowledged_at = NULL, acknowledged_by = NULL, acknowledge_note = NULL`).run(...args);

// SQLite datetime('now') is 'YYYY-MM-DD HH:MM:SS' in UTC.
const sqliteMs = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : NaN);
function holdExpired(row, hours) {
  const since = sqliteMs(row.hold_since);
  return Number.isFinite(since) && Date.now() - since >= hours * 3600 * 1000;
}

// One plan read per event per run, cached. A read that FAILS must never make
// the write-back worse than it was before the guard existed, so the failure
// is recorded and the push proceeds exactly as it always did.
async function plansFor(session, tlcEventId, cache) {
  if (cache.has(tlcEventId)) return cache.get(tlcEventId);
  let v;
  try {
    const plans = await tlcPlans.fetchPlans(fetcher(), session, tlcEventId);
    v = { plans, warnings: tlcPlans.planWarnings(plans), error: null };
  } catch (e) {
    v = { plans: null, warnings: [], error: e.message };
  }
  cache.set(tlcEventId, v);
  return v;
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
    return { skipped: true, reason: portal.t('Paused after a failed TLC login — re-save credentials or use Push now.') };
  }
  if (state.code_required_at) {
    return { skipped: true, reason: portal.t('Paused until the TLC sign-in code is entered — Admin → Roster import → Connect.') };
  }
  const pending = db.prepare(`SELECT * FROM tlc_attendance_push WHERE status = 'pending' ORDER BY id`).all();
  if (!pending.length) return { skipped: true, reason: 'Nothing pending.' };
  // Nothing here but parked rows: re-check them on their own slower clock so
  // a plan nobody is fixing does not log in to TLC every ten minutes forever.
  if (!manual && pending.every((r) => r.hold_reason)) {
    const last = sqliteMs(state.last_hold_poll) || Date.parse(state.last_hold_poll || '');
    if (Number.isFinite(last) && Date.now() - last < HOLD_POLL_MS) {
      return { skipped: true, reason: 'Only held rows pending — next re-check later.' };
    }
    patchState({ last_hold_poll: new Date().toISOString() });
  }

  running = true;
  const settings = getSettings();
  const summary = { sent: 0, already: 0, failed: 0, held: 0, warned: 0, released: 0 };
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
      // signed in again: drop both latches
      if (state.auth_failed_at || state.code_required_at) patchState({ auth_failed_at: null, code_required_at: null });
    } catch (e) {
      // Auth latch: NEVER retry a rejected login on a timer. code 2 = login
      // rejected (fetch-roster semantics); anything else is transient network.
      const auth = e && e.code === 2;
      const needsCode = e && e.code === 6;
      patchState({
        last_run: new Date().toISOString(), last_status: needsCode ? 'code_required' : 'failed',
        last_error: e.message,
        ...(auth ? { auth_failed_at: new Date().toISOString() } : {}),
        ...(needsCode ? { code_required_at: new Date().toISOString() } : {}),
      });
      return { failed_login: true, auth_latched: !!auth, code_required: !!needsCode, error: e.message };
    }

    const lists = new Map();      // tlcEventId → parsed user list (one fetch each)
    const planCache = new Map();  // tlcEventId → {plans, warnings, error}
    const planWarnings = new Map(); // tlcEventId → warnings, for the admin panel
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
          unholdRow(row.id);
          mark.run('sent', portal.t('already marked on TLC'), m.hash, 'sent', row.id);
          summary.already++; continue;
        }

        // ---- activity-plan guard ------------------------------------------
        // Only rows that expect advancement have anything to lose: an
        // attendance-only push (use_lesson_plans=0) and every adult go
        // straight through, exactly as before the guard existed.
        let note = null;
        if (settings.plan_check !== 'off' && row.use_lesson_plans) {
          const pf = await plansFor(session, row.tlc_event_id, planCache);
          if (pf.warnings.length) planWarnings.set(row.tlc_event_id, pf.warnings);
          if (pf.plans) {
            const cov = tlcPlans.coverageFor(pf.plans, m.hash, list.users.get(m.hash));
            if (cov.applicable && !cov.covered) {
              if (settings.plan_check === 'hold' && !holdExpired(row, settings.hold_release_hours)) {
                // Park it. TLC has not seen this person yet, so the one
                // chance to record their advancement is still intact.
                holdRow(cov.reason, row.id);
                summary.held++; continue;
              }
              if (settings.plan_check === 'hold') {
                // Window is up: the attendance record matters more than a
                // perfect hold, so push — but write down exactly what was
                // given up, where a human has to come and clear it.
                insSkipped(row.id, row.event_id, row.person_id, row.tlc_event_id, m.hash,
                  cov.reason,
                  JSON.stringify({ plans: pf.plans.plans, warnings: pf.warnings }),
                  row.hold_since);
                note = portal.t('released after hold — advancement was NOT recorded');
                summary.released++;
              } else {
                note = portal.t('advancement did not apply: ') + cov.reason;
                summary.warned++;
              }
            } else if (row.hold_reason) {
              unholdRow(row.id); // the plan was fixed — send it for real
            }
          } else if (pf.error) {
            note = portal.t('activity plan could not be read: ') + pf.error;
          }
        }

        await toggleAttendance(session, {
          userId: m.hash, eventId: row.tlc_event_id, useLessonPlans: row.use_lesson_plans,
        });
        unholdRow(row.id); // sent is sent — a parked row is parked no longer
        mark.run('sent', note, m.hash, 'sent', row.id);
        summary.sent++;
      } catch (e) {
        mark.run('failed', e.message, null, 'failed', row.id);
        summary.failed++;
      }
    }
    // Plan problems are a property of the EVENT, not of one row — surface
    // them against the event title so the panel can name what to go and fix.
    const warnings = [];
    for (const [tlcEventId, list] of planWarnings) {
      const ev = db.prepare(
        'SELECT title FROM event WHERE tlc_event_id = ? ORDER BY start_at DESC LIMIT 1').get(tlcEventId);
      for (const w of list) warnings.push({ event: ev ? ev.title : tlcEventId, warning: w });
    }
    patchState({
      last_run: new Date().toISOString(),
      last_status: summary.failed ? 'partial' : 'ok',
      last_error: summary.failed ? `${summary.failed} row(s) failed — see the log.` : null,
      plan_warnings: warnings,
    });
    return summary;
  } finally {
    running = false;
  }
}

// ------------------------------------------- skipped-advancement log -------
// Everything the auto-release gave up, kept until a human says otherwise.
// Dismissal is two-step ON PURPOSE: step one re-reads TLC and checks the
// youth actually holds the items now, step two records the acknowledgement.
// Clearing a row you have not verified is possible but requires an explicit
// force plus a note, so "I'll sort it later" cannot look like "sorted".
function skippedRows({ includeAcknowledged = false, limit = 200 } = {}) {
  return db.prepare(
    `SELECT s.*, p.first_name || ' ' || p.last_name AS person_name,
            e.title AS event_title, e.start_at AS event_start,
            st.name AS acknowledged_by_name
       FROM tlc_advancement_skipped s
       JOIN person p ON p.id = s.person_id
       JOIN event  e ON e.id = s.event_id
  LEFT JOIN staff  st ON st.id = s.acknowledged_by
      WHERE (? = 1 OR s.acknowledged_at IS NULL)
      ORDER BY s.acknowledged_at IS NULL DESC, s.released_at DESC, s.id DESC
      LIMIT ?`).all(includeAcknowledged ? 1 : 0, limit);
}

const snapshotItems = (row) => {
  try {
    const snap = JSON.parse(row.plan_snapshot || '{}');
    const ids = new Set();
    for (const p of snap.plans || []) for (const it of p.items || []) ids.add(it);
    return [...ids];
  } catch { return []; }
};

// Step one: ask TLC whether the advancement is there now.
async function verifySkipped(id, env = process.env) {
  const row = db.prepare('SELECT * FROM tlc_advancement_skipped WHERE id = ?').get(id);
  if (!row) { const e = new Error('No such skipped row.'); e.code = 404; throw e; }
  if (!row.tlc_user_id) { const e = new Error(portal.t('That row has no TLC user id to check.')); e.code = 422; throw e; }

  const set = db.prepare(
    `UPDATE tlc_advancement_skipped
        SET verified_at = datetime('now'), verify_result = ?, verify_detail = ?
      WHERE id = ?`);
  let plans;
  try {
    plans = await tlcPlans.fetchPlans(fetcher(), await tlcSession(env), row.tlc_event_id);
  } catch (e) {
    set.run('error', e.message, id);
    return { ...row, verify_result: 'error', verify_detail: e.message };
  }
  // What the plan offered when the push was released; fall back to whatever
  // it offers now if the snapshot is missing.
  let expected = snapshotItems(row);
  if (!expected.length) {
    expected = [...new Set(plans.plans.flatMap((p) => p.items))];
  }
  const held = plans.held.get(row.tlc_user_id) || new Set();
  const missing = expected.filter((it) => !held.has(it));
  const label = (it) => plans.itemTitles.get(it) || it;
  const result = !expected.length ? 'not_found' : (missing.length ? 'not_found' : 'confirmed');
  const detail = !expected.length
    ? portal.t('The event has no activity plan items to check against.')
    : (missing.length
      ? portal.t('Still missing on TLC: ') + missing.map(label).join(', ')
      : portal.t('Recorded on TLC: ') + expected.map(label).join(', '));
  set.run(result, detail, id);
  return { ...row, verified_at: new Date().toISOString(), verify_result: result, verify_detail: detail };
}

// Step two: clear it.
function acknowledgeSkipped(id, { staffId = null, note = null, force = false } = {}) {
  const row = db.prepare('SELECT * FROM tlc_advancement_skipped WHERE id = ?').get(id);
  if (!row) { const e = new Error('No such skipped row.'); e.code = 404; throw e; }
  if (row.acknowledged_at) { const e = new Error(portal.t('That row was already cleared.')); e.code = 409; throw e; }
  if (row.verify_result !== 'confirmed') {
    if (!force) {
      const e = new Error(portal.t('Check Trail Life Connect first — press Verify on TLC. If it really is fixed and the check still disagrees, clear it with a note.'));
      e.code = 409; throw e;
    }
    if (!String(note || '').trim()) {
      const e = new Error(portal.t('Clearing an unverified row needs a note saying what was done.'));
      e.code = 422; throw e;
    }
  }
  db.prepare(
    `UPDATE tlc_advancement_skipped
        SET acknowledged_at = datetime('now'), acknowledged_by = ?, acknowledge_note = ?
      WHERE id = ?`).run(staffId, String(note || '').trim() || null, id);
  return { ok: true, id };
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
  PLAN_CHECK_MODES, plansFor, holdExpired,
  skippedRows, verifySkipped, acknowledgeSkipped,
  tlcIdFromBadge, adoptBadgeTlcId, backfillFromBadges,
  normName, nameKey, parseUserList, matchPerson,
  tlcSession, fetchUserList, toggleAttendance,
  runPush, isRunning, scheduleSweep,
};
