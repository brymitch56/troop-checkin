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

// Active members (youth AND adults — everyone camps) with no form date on
// file at all. Alphabetical; youth first so the patrol chase-list reads top-down.
function missingPeople(form) {
  const field = FORM_FIELDS[form];
  if (!field) throw new Error(`Unknown form kind: ${form}`);
  return db.prepare(
    `SELECT ${personCols} FROM person
      WHERE status = 'active' AND ${field} IS NULL
      ORDER BY is_youth DESC, last_name, first_name`
  ).all();
}

// Active members whose form has expired or expires within `days` days,
// soonest/most-lapsed first (mirrors membership.expiringPeople).
function expiringPeople(form, days) {
  const field = FORM_FIELDS[form];
  if (!field) throw new Error(`Unknown form kind: ${form}`);
  const rows = db.prepare(
    `SELECT ${personCols}, ${field} AS submitted_on FROM person
      WHERE status = 'active' AND ${field} IS NOT NULL`
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

module.exports = { HEALTH_FORM_VALID_DAYS, FORM_FIELDS, expiryOf, missingPeople, expiringPeople };
