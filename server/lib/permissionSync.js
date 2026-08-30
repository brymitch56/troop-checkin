'use strict';
// Per-event permission-form sync — requirement detection + per-youth signed
// status from Trail Life Connect. All mechanics verified against the live
// site 2026-08-30 (VERIFY-permission-forms-findings, kept outside the repo):
//
//   - /calendar/view-events (auth GET, paginated grid): each row carries
//     data-key="<ev-hashid>" (== event.tlc_event_id), an
//     /calendar/update/<et-slug> link (the export slug — a SEPARATE id space,
//     not derivable from the hashid), and a "Forms Completed" cell that is
//     EMPTY unless the event requires forms (an icon renders when it does).
//     Only the cell's non-emptiness is meaningful — its check/cross state
//     tracks the troop-side planning forms, NEVER parent signatures.
//   - /calendar/exportexcel/<et-slug>?format=xlsx: whole-roster participant
//     export with a literal "Event Permission Form" Yes/No column, keyed by
//     Member Number. May 503 while generating (retry); an invalid slug
//     returns HTTP 200 with HTML, so the PK zip magic is validated before
//     parsing. Title row above headers; header row found by "Member Number".
//
// Cadence (decided 2026-08-30 — TLC's forms setting is often enabled weeks
// after an event is created, so detection is continuous, never one-shot):
//   - nightly: full grid sweep (requirement + slug for every grid event we
//     know) + status fetch for form-required linked events starting within
//     WINDOW_DAYS;
//   - hourly: "imminent" pass — re-fetch any form-required event starting
//     within IMMINENT_H hours whose status is staler than STALE_H hours
//     (guarantees fresh data by T-24h and keeps improving toward T-0);
//   - on demand: per-event refresh from admin, and rate-limited from the
//     kiosk door role (the parent-signed-in-the-parking-lot case).
//
// Youth only by decision: parents sign for youth; adult export rows are
// ignored. Everything is gated behind an admin switch (meta key, default
// OFF) and env TLC_ENABLED — the repo rule: nothing changes kiosk behavior
// until an admin turns it on.
const { db } = require('../db');

const fetcher = () => require('../scripts/fetch-roster');
const attendance = () => require('./attendanceSync');

const WINDOW_DAYS = 7;     // nightly status window (starts within N days)
const IMMINENT_H = 26;     // hourly pass: events starting within this many hours
const STALE_H = 6;         // ...refetched when data is older than this
const KIOSK_REFRESH_MIN_S = 60; // per-event floor between kiosk-triggered fetches

// ----------------------------------------------------------- settings ------
// meta key 'permission_forms' — {enabled: 0|1}. Default OFF.
const KEY = 'permission_forms';

function getSettings() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
  let v = {};
  if (row) { try { v = JSON.parse(row.value); } catch { /* ignore */ } }
  return { enabled: v.enabled ? 1 : 0 };
}

function saveSettings(b) {
  const v = { enabled: b && b.enabled ? 1 : 0 };
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(KEY, JSON.stringify(v));
  return v;
}

const active = (env = process.env) =>
  getSettings().enabled === 1 && String(env.TLC_ENABLED).toLowerCase() !== 'false';

// ---------------------------------------------------------- grid parse -----
// Tolerant Yii2-GridView parsing: find the "Forms Completed" column's
// data-col-seq from the header row, then per <tr data-key="ev…"> read that
// column's cell. "Required" = the cell renders anything (tag or text beyond
// whitespace/&nbsp;) — presence only, never the icon's state.
function parseGrid(html) {
  const h = String(html || '');
  let seq = null;
  const th = /<th[^>]*data-col-seq="(\d+)"[^>]*>([\s\S]*?)<\/th>/g;
  let m;
  while ((m = th.exec(h))) {
    if (/Forms\s*Completed/i.test(m[2])) { seq = m[1]; break; }
  }
  const rows = [];
  const tr = /<tr[^>]*data-key="(ev[a-z0-9]+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((m = tr.exec(h))) {
    const hashid = m[1];
    const rowHtml = m[2];
    const slugM = /\/calendar\/update\/(et[a-z0-9]+)/i.exec(rowHtml);
    let required = null; // unknown when the column is missing
    if (seq != null) {
      const cellM = new RegExp(
        `<td[^>]*data-col-seq="${seq}"[^>]*>([\\s\\S]*?)<\\/td>`).exec(rowHtml);
      if (cellM) {
        const inner = cellM[1].replace(/&nbsp;|\s+/g, '');
        required = inner.length > 0 ? 1 : 0;
      }
    }
    rows.push({ tlc_event_id: hashid, et_slug: slugM ? slugM[1] : null, required });
  }
  return rows;
}

// Apply grid rows to linked events. The et-slug is always adopted; the
// requirement flag is only auto-managed while the admin has not taken it
// over ('manual' wins forever after). Returns counts for logs/tests.
function applyGrid(rows) {
  let slugs = 0, flagged = 0, cleared = 0;
  const apply = db.transaction(() => {
    for (const r of rows) {
      const ev = db.prepare(
        `SELECT id, requires_permission_form, permission_form_source, tlc_et_slug
           FROM event WHERE tlc_event_id = ?`).get(r.tlc_event_id);
      if (!ev) continue;
      if (r.et_slug && r.et_slug !== ev.tlc_et_slug) {
        db.prepare('UPDATE event SET tlc_et_slug = ? WHERE id = ?').run(r.et_slug, ev.id);
        slugs++;
      }
      if (r.required == null || ev.permission_form_source === 'manual') continue;
      if (r.required !== ev.requires_permission_form) {
        db.prepare(
          `UPDATE event SET requires_permission_form = ?, permission_form_source = 'auto'
            WHERE id = ?`).run(r.required, ev.id);
        r.required ? flagged++ : cleared++;
      } else if (!ev.permission_form_source) {
        db.prepare(`UPDATE event SET permission_form_source = 'auto' WHERE id = ?`).run(ev.id);
      }
    }
  });
  apply();
  return { slugs, flagged, cleared };
}

async function fetchGridPage(s, page) {
  const F = fetcher();
  const res = await F.request(s.cfg, s.jar,
    `/calendar/view-events${page > 1 ? `?page=${page}` : ''}`, { method: 'GET' });
  const html = await res.text();
  if (res.status !== 200 || /LoginForm\[password\]/.test(html)) {
    throw new Error(`TLC view-events page ${page} failed (status ${res.status}).`);
  }
  return html;
}

// Sweep the grid (a few pages cover months ahead). Stops when a page yields
// no rows or repeats the first row of the previous page (defensive against
// pagination quirks); MAX_PAGES caps the walk either way.
async function sweepGrid(s, maxPages = 4) {
  const all = [];
  let prevFirst = null;
  for (let p = 1; p <= maxPages; p++) {
    const rows = parseGrid(await fetchGridPage(s, p));
    if (!rows.length || (rows[0] && rows[0].tlc_event_id === prevFirst)) break;
    prevFirst = rows[0].tlc_event_id;
    all.push(...rows);
    if (rows.length < 20) break; // short page = last page
  }
  return { rows: all, ...applyGrid(all) };
}

// -------------------------------------------------------- export parse -----
// Whole-roster participants export -> per-YOUTH signed map. Reuses the
// roster importer's conventions: sheet_to_json raw:false, header row found
// by "Member Number". Accepts xlsx (PK zip magic) OR CSV bytes — TLC has
// form for answering 200 with CSV where xlsx was asked for (the roster
// export mislabels content types the same way; live finding 2026-08-29) —
// and rejects HTML (login page / bad slug) with a readable error.
const isZip = (buf) => buf && buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
const isHtml = (buf) => /^\s*</.test(String(buf ? buf.slice(0, 200) : ''));

function parseExport(buffer) {
  if (!buffer || !buffer.length || isHtml(buffer)) {
    throw new Error('TLC returned a web page instead of an export (bad slug or expired session?).');
  }
  const XLSX = require('xlsx');
  const wb = isZip(buffer)
    ? XLSX.read(buffer, { type: 'buffer' })
    : XLSX.read(buffer.toString('utf8'), { type: 'string' }); // CSV bytes
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const norm = (v) => (v == null ? '' : String(v).trim());
  const hdrIdx = rows.findIndex((r) => r.some((c) => norm(c) === 'Member Number'));
  if (hdrIdx === -1) throw new Error('No "Member Number" header — not a TLC participants export?');
  const col = {};
  rows[hdrIdx].forEach((name, i) => { const n = norm(name); if (n) col[n] = i; });
  if (!('Event Permission Form' in col)) {
    throw new Error('Export has no "Event Permission Form" column — TLC layout changed?');
  }
  const out = [];
  for (const r of rows.slice(hdrIdx + 1)) {
    const member = norm(r[col['Member Number']]);
    if (!member) continue; // unregistered/blank rows can't be keyed
    out.push({ member_id: member, signed: norm(r[col['Event Permission Form']]) === 'Yes' ? 1 : 0 });
  }
  return out;
}

// The VERIFIED export URL (live fix 2026-08-29): the blank rsvp_type filter
// is REQUIRED — without it TLC answers 200 with CSV after long generation
// waits; with it the same slug returns proper XLSX on the first attempt,
// covering the WHOLE roster (blank = all RSVP statuses, never just
// "Going"). Same URL the RSVP tooling uses. Do not "simplify" it away.
const exportPath = (etSlug) =>
  `/calendar/exportexcel/${etSlug}?format=xlsx&EventParticipantsSearch%5Brsvp_type%5D=`;

async function fetchExport(s, etSlug) {
  const F = fetcher();
  // first request may 503 while TLC generates the file — bounded retries
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await F.request(s.cfg, s.jar, exportPath(etSlug), { method: 'GET' });
    const buf = Buffer.from(await res.arrayBuffer());
    // accept anything parseable: xlsx OR CSV bytes (parseExport sniffs);
    // only HTML (login/bad slug) and non-200s keep the retry loop going
    if (res.status === 200 && buf.length && !isHtml(buf)) return buf;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`TLC export for the event did not become ready (slug ending …${etSlug.slice(-4)}).`);
}

// Store the export's YOUTH rows for one event (replaces that event's rows).
function storeStatuses(eventId, parsed, source = 'sync') {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM event_form_status WHERE event_id = ?').run(eventId);
    const ins = db.prepare(
      `INSERT INTO event_form_status (event_id, person_id, signed, fetched_at, source)
       VALUES (?, ?, ?, datetime('now'), ?)`);
    let stored = 0;
    for (const row of parsed) {
      const p = db.prepare(
        `SELECT id FROM person WHERE member_id = ? AND is_youth = 1 AND status != 'merged'`
      ).get(row.member_id);
      if (!p) continue; // adults and unknown members are ignored by decision
      ins.run(eventId, p.id, row.signed, source);
      stored++;
    }
    return stored;
  });
  return run();
}

// Refresh one event's signed statuses (admin refresh, kiosk re-check, jobs).
async function refreshEvent(eventId, session) {
  const ev = db.prepare('SELECT * FROM event WHERE id = ?').get(eventId);
  if (!ev) throw new Error('No such event.');
  const s = session || await attendance().tlcSession();
  let slug = ev.tlc_et_slug;
  if (!slug) {
    await sweepGrid(s); // grid supplies the slug; also refreshes requirements
    slug = db.prepare('SELECT tlc_et_slug FROM event WHERE id = ?').get(eventId).tlc_et_slug;
    if (!slug) throw new Error('This event has no TLC export link yet — is it on the TLC calendar?');
  }
  const stored = storeStatuses(eventId, parseExport(await fetchExport(s, slug)), 'sync');
  return { stored, fetched_at: new Date().toISOString() };
}

// Kiosk-facing rate limit: at most one TLC fetch per event per minute.
const lastKioskRefresh = new Map();
function kioskRefreshAllowed(eventId) {
  const last = lastKioskRefresh.get(eventId) || 0;
  if (Date.now() - last < KIOSK_REFRESH_MIN_S * 1000) return false;
  lastKioskRefresh.set(eventId, Date.now());
  return true;
}

// ------------------------------------------------------------- queries -----
// Unsigned/unknown = flagged. A youth ABSENT from event_form_status counts
// as unsigned (no data is not consent) — fetched_at then comes from the
// event's newest row, or null when nothing was ever fetched.
function unsignedYouthIds(eventId, personIds) {
  const out = [];
  for (const pid of personIds) {
    const row = db.prepare(
      'SELECT signed FROM event_form_status WHERE event_id = ? AND person_id = ?')
      .get(eventId, pid);
    if (!row || !row.signed) out.push(pid);
  }
  return out;
}

const lastFetchedAt = (eventId) => {
  const r = db.prepare(
    'SELECT MAX(fetched_at) AS at FROM event_form_status WHERE event_id = ?').get(eventId);
  return r && r.at ? r.at : null;
};

// ---------------------------------------------------------------- jobs -----
function statusWindowEvents(hoursAhead) {
  return db.prepare(
    `SELECT * FROM event
      WHERE requires_permission_form = 1 AND tlc_event_id IS NOT NULL
        AND datetime(end_at) >= datetime('now')
        AND datetime(start_at) <= datetime('now', '+' || ? || ' hours')`
  ).all(hoursAhead);
}

async function nightly() {
  if (!active()) return { skipped: 'disabled' };
  const s = await attendance().tlcSession();
  const grid = await sweepGrid(s);
  let fetched = 0, failed = 0;
  for (const ev of statusWindowEvents(WINDOW_DAYS * 24)) {
    try { await refreshEvent(ev.id, s); fetched++; }
    catch (e) { failed++; console.error(`[permission-forms] event #${ev.id}: ${e.message}`); }
  }
  return { grid: { rows: grid.rows.length, flagged: grid.flagged, cleared: grid.cleared, slugs: grid.slugs }, fetched, failed };
}

// Hourly imminent pass — T-24h freshness guarantee without hammering TLC.
async function imminent() {
  if (!active()) return { skipped: 'disabled' };
  const due = statusWindowEvents(IMMINENT_H).filter((ev) => {
    const at = lastFetchedAt(ev.id);
    return !at || (Date.now() - new Date(at + 'Z').getTime()) > STALE_H * 3600 * 1000;
  });
  if (!due.length) return { fetched: 0 };
  const s = await attendance().tlcSession();
  let fetched = 0;
  for (const ev of due) {
    try { await refreshEvent(ev.id, s); fetched++; }
    catch (e) { console.error(`[permission-forms] imminent #${ev.id}: ${e.message}`); }
  }
  return { fetched };
}

function scheduleJobs() {
  const nightlyTimer = setInterval(() => {
    nightly().catch((e) => console.error('[permission-forms] nightly failed:', e.message));
  }, 24 * 60 * 60 * 1000);
  nightlyTimer.unref();
  const hourlyTimer = setInterval(() => {
    imminent().catch((e) => console.error('[permission-forms] imminent failed:', e.message));
  }, 60 * 60 * 1000);
  hourlyTimer.unref();
  // one sweep shortly after boot (mirrors icalSync) so a restart never
  // leaves a campout morning stale; no-op while the switch is off
  setTimeout(() => nightly().catch((e) => console.error('[permission-forms] boot sweep failed:', e.message)), 30_000).unref();
  return { nightlyTimer, hourlyTimer };
}

module.exports = {
  getSettings, saveSettings, active,
  parseGrid, applyGrid, sweepGrid, parseExport, fetchExport, exportPath, storeStatuses,
  refreshEvent, kioskRefreshAllowed, unsignedYouthIds, lastFetchedAt,
  nightly, imminent, scheduleJobs,
  WINDOW_DAYS, IMMINENT_H, STALE_H,
};
