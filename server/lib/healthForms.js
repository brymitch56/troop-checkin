'use strict';
// Health-form tracking. TLC's "Health Form" / "High Risk Form" columns record
// the SUBMISSION date, not an expiry — Trail Life health forms are customarily
// good for 12 months, so expiry is assumed to be submission + 365 days. The
// assumption is a visible constant here and surfaced in the report UI ("valid
// 12 months from submission") so a wrong assumption is loud, not silent.
// Same defensive posture as lib/membership.js: unparseable stored dates are
// "no usable date" at compare time (they count as on file, never as expiring).
const { db } = require('../db');
const { daysUntil } = require('./membership');

const HEALTH_FORM_VALID_DAYS = 365;

// The two tracked forms. "High Risk" is the High Adventure medical clearance
// — a different form from the annual health form, never conflated.
const FORM_FIELDS = {
  health: 'health_form_date',
  high_risk: 'high_risk_form_date',
};

const pad = (n) => String(n).padStart(2, '0');

// Expiry date (ISO) for a stored submission date; null when missing/unparseable.
function expiryOf(submitted) {
  if (!submitted) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(submitted));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(submitted);
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + HEALTH_FORM_VALID_DAYS);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const personCols = `id, is_youth, member_id, first_name, last_name, nickname,
                    patrol, level, role`;

// Form coverage is "every youth and registered adult" (decided 2026-08-29):
// visitors and unregistered adults (consent-form pickup designees — no
// member number) are not troop members and would pad "not on file" forever.
const SCOPE = `status = 'active' AND (is_youth = 1 OR member_id IS NOT NULL)`;

// In-scope members with no form date on file at all. Alphabetical; youth
// first so the patrol chase-list reads top-down.
function missingPeople(form) {
  const field = FORM_FIELDS[form];
  if (!field) throw new Error(`Unknown form kind: ${form}`);
  return db.prepare(
    `SELECT ${personCols} FROM person
      WHERE ${SCOPE} AND ${field} IS NULL
      ORDER BY is_youth DESC, last_name, first_name`
  ).all();
}

// In-scope members whose form has expired or expires within `days` days,
// soonest/most-lapsed first (mirrors membership.expiringPeople).
function expiringPeople(form, days) {
  const field = FORM_FIELDS[form];
  if (!field) throw new Error(`Unknown form kind: ${form}`);
  const rows = db.prepare(
    `SELECT ${personCols}, ${field} AS submitted_on FROM person
      WHERE ${SCOPE} AND ${field} IS NOT NULL`
  ).all();
  return rows
    .map((p) => {
      const expires_on = expiryOf(p.submitted_on);
      return { ...p, expires_on, days_left: daysUntil(expires_on) };
    })
    .filter((p) => p.days_left != null && p.days_left <= days)
    .sort((a, b) => (a.days_left - b.days_left)
      || a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
}

// ------------------------------------------------- check-in badge switch ----
// meta key 'checkin_flags' — {health_form: 0|1}. Gates the KIOSK badge for
// missing/expired health forms (default OFF: today's TLC data is nearly all
// blank, so the badge would flag almost everyone until the backfill lands).
// The dashboard cards and reports above are admin-facing and always on.
// The per-event High Adventure badge is driven by
// event.requires_high_adventure_form, not by this switch.
const FLAGS_KEY = 'checkin_flags';

function getCheckinFlags() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(FLAGS_KEY);
  let v = {};
  if (row) { try { v = JSON.parse(row.value); } catch { /* ignore */ } }
  return { health_form: v.health_form ? 1 : 0 };
}

function saveCheckinFlags(b) {
  const flags = { health_form: b && b.health_form ? 1 : 0 };
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(FLAGS_KEY, JSON.stringify(flags));
  return flags;
}

module.exports = { HEALTH_FORM_VALID_DAYS, FORM_FIELDS, expiryOf, missingPeople, expiringPeople,
  getCheckinFlags, saveCheckinFlags };
