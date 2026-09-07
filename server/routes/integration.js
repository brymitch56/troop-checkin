'use strict';
// Integration API — read-only JSON for external systems (docs/13-integration-api.md).
//
// Server-to-server only: every route sits behind the instance API key
// (lib/integrationAuth, Bearer header, no cookie fallback, no CORS). The
// contract deliberately exposes the MINIMUM: stable identifiers
// (member_id, tlc_user_id, person id; ical_uid + start_at for events),
// names, level/patrol, and sign-in/out times. No guardians, phones, emails,
// addresses, birthdates, signatures, photos, health or consent data — ever.
const express = require('express');
const { db } = require('../db');
const env = require('../lib/env');
const { requireApiKey } = require('../lib/integrationAuth');
// version for /ping — tolerant: the selfcheck boot test copies server/ alone
let pkgVersion = null;
try { pkgVersion = require('../../package.json').version; } catch { /* not shipped alongside */ }

const router = express.Router();
router.use(requireApiKey);

const EVENT_LIMIT = 500;
const PEOPLE_LIMIT = 2000;

const EVENT_COLS = `id, ical_uid, tlc_event_id, source, title, location, start_at, end_at,
                    all_day, track_adults, removed_from_feed, requires_permission_form`;

const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const shiftDays = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

router.get('/ping', (req, res) => {
  res.json({
    ok: true, app: 'troop-checkin', version: pkgVersion,
    troop_id: env.TROOP_ID, theme: env.THEME,
    tz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: new Date().toISOString(),
  });
});

// Events whose LOCAL start date falls in [from, to]. Default window: 30 days
// back to 60 days ahead. Manual events (ical_uid null) and feed-removed events
// are included — the consumer decides what to plan against. Capped at 500.
router.get('/events', (req, res) => {
  const from = req.query.from || shiftDays(-30);
  const to = req.query.to || shiftDays(60);
  if (!isoDate(from) || !isoDate(to)) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
  }
  const rows = db.prepare(
    `SELECT ${EVENT_COLS} FROM event
      WHERE local_date(start_at) BETWEEN ? AND ?
      ORDER BY start_at, id LIMIT ${EVENT_LIMIT}`
  ).all(from, to);
  res.json(rows);
});

// Follow merged records to the surviving one (bounded — merges never cycle,
// but never trust a loop to terminate on data).
function resolvePerson(id) {
  let p = db.prepare('SELECT * FROM person WHERE id = ?').get(id);
  for (let i = 0; p && p.status === 'merged' && p.merged_into_id && i < 8; i++) {
    p = db.prepare('SELECT * FROM person WHERE id = ?').get(p.merged_into_id);
  }
  return p && p.status !== 'merged' ? p : null;
}

// Presence at one event, derived from txn + txn_person:
//   - voided txns are ignored (voided_by_txn_id set), and so are the void
//     MARKER rows themselves (an 'in' with close_method set is only ever a
//     void marker — kiosk sign-ins never carry close_method)
//   - one row per person: the EARLIEST non-voided sign-in, and the sign-out
//     that closed it (txn_person.in_txn_id = that sign-in), if any
//   - open = 1 means still signed in; the consumer decides what "present" means
//   - adults only when the event tracks them; visitors included (status tells)
//   - merged persons resolve to the surviving record
function attendanceFor(event) {
  const ins = db.prepare(
    `SELECT t.id AS in_txn_id, t.signed_at, t.forced, t.permission_override,
            tp.person_id, tp.open
       FROM txn t JOIN txn_person tp ON tp.txn_id = t.id
      WHERE t.event_id = ? AND t.direction = 'in'
        AND t.voided_by_txn_id IS NULL AND t.close_method IS NULL
      ORDER BY t.signed_at, t.id`
  ).all(event.id);
  const outFor = db.prepare(
    `SELECT t.id AS out_txn_id, t.signed_at
       FROM txn t JOIN txn_person tp ON tp.txn_id = t.id
      WHERE t.event_id = ? AND t.direction = 'out' AND t.voided_by_txn_id IS NULL
        AND tp.in_txn_id = ? AND tp.person_id = ?
      ORDER BY t.signed_at, t.id LIMIT 1`
  );
  const seen = new Map(); // resolved person id → row
  for (const r of ins) {
    const p = resolvePerson(r.person_id);
    if (!p) continue;
    if (!p.is_youth && !event.track_adults) continue;
    if (seen.has(p.id)) continue; // earliest wins (ordered by signed_at)
    const out = outFor.get(event.id, r.in_txn_id, r.person_id);
    seen.set(p.id, {
      person_id: p.id, member_id: p.member_id, tlc_user_id: p.tlc_user_id,
      last_name: p.last_name, first_name: p.first_name, nickname: p.nickname,
      is_youth: p.is_youth ? 1 : 0, level: p.level, patrol: p.patrol, status: p.status,
      signed_in_at: r.signed_at, signed_out_at: out ? out.signed_at : null,
      open: r.open ? 1 : 0,
      forced: r.forced ? 1 : 0, permission_override: r.permission_override ? 1 : 0,
      sign_in_txn_id: r.in_txn_id, sign_out_txn_id: out ? out.out_txn_id : null,
    });
  }
  return [...seen.values()].sort((a, b) =>
    (b.is_youth - a.is_youth) || a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
}

function sendAttendance(res, event) {
  res.json({
    event: {
      id: event.id, ical_uid: event.ical_uid, tlc_event_id: event.tlc_event_id, title: event.title,
      start_at: event.start_at, end_at: event.end_at, track_adults: event.track_adults ? 1 : 0,
    },
    generated_at: new Date().toISOString(),
    attendance: attendanceFor(event),
  });
}

router.get('/events/:id/attendance', (req, res) => {
  const event = db.prepare('SELECT * FROM event WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'no such event' });
  sendAttendance(res, event);
});

// Lookup by the shared iCal identity (UNIQUE (ical_uid, start_at) in the
// schema). start_at must match the stored ISO string exactly, so accept any
// parseable timestamp and normalize it the way icalSync stores it.
router.get('/attendance', (req, res) => {
  const { ical_uid, start_at } = req.query;
  if (!ical_uid || !start_at) return res.status(400).json({ error: 'ical_uid and start_at are required' });
  const t = new Date(start_at);
  if (Number.isNaN(t.getTime())) return res.status(400).json({ error: 'start_at must be an ISO timestamp' });
  const event = db.prepare('SELECT * FROM event WHERE ical_uid = ? AND start_at = ?').get(ical_uid, t.toISOString());
  if (!event) return res.status(404).json({ error: 'no such event' });
  sendAttendance(res, event);
});

// Minimal roster: active + visitor people, youth and registered adults, so a
// consumer can match identities before any attendance exists. No contact
// fields, no form dates, no photos. Capped at 2,000.
router.get('/people', (req, res) => {
  const rows = db.prepare(
    `SELECT id, member_id, tlc_user_id, last_name, first_name, nickname, is_youth, level, patrol,
            status, membership_expires
       FROM person
      WHERE status IN ('active', 'visitor')
      ORDER BY is_youth DESC, last_name, first_name, id LIMIT ${PEOPLE_LIMIT}`
  ).all();
  res.json(rows);
});

module.exports = router;
module.exports.attendanceFor = attendanceFor;
