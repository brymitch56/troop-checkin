'use strict';
// Membership-expiration helpers. The roster parser reads cells with raw:false,
// so "Membership Exp." arrives as a formatted STRING whose exact shape we
// can't fully trust — everything here is defensive: normalize what we
// recognize, keep the raw value otherwise, and treat unparseable dates as
// "no date" at compare time (never block, never crash).
const { db } = require('../db');

const pad = (n) => String(n).padStart(2, '0');

// Normalize a date-cell string to ISO YYYY-MM-DD when the format is
// recognizable (ISO, US M/D/YYYY, M/D/YY, or anything Date can parse, e.g.
// "Aug 5, 2026"); otherwise return the trimmed raw string so no data is lost.
function normalizeDateCell(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T ])/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += y >= 70 ? 1900 : 2000; // xlsx raw:false 2-digit years
    return `${y}-${pad(m[1])}-${pad(m[2])}`;
  }
  const d = new Date(s);
  if (!isNaN(d)) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return s; // unrecognized — store raw, parse defensively later
}

// Whole days from today (local, day-granular like the events past-rule) until
// the stored expiration. 0 = expires today, negative = already expired,
// null = no date / unparseable.
function daysUntil(dateStr, today = new Date()) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(dateStr);
  if (isNaN(d)) return null;
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((d0 - t0) / 86400000);
}

// Active members (youth AND registered adults — leadership chases both) whose
// membership has expired or expires within `days` days, soonest/most-lapsed
// first. Done in JS via daysUntil so non-ISO stored values still work.
function expiringPeople(days) {
  const rows = db.prepare(
    `SELECT id, is_youth, member_id, first_name, last_name, nickname, patrol,
            level, role, membership_expires
       FROM person
      WHERE status = 'active' AND membership_expires IS NOT NULL`
  ).all();
  return rows
    .map((p) => ({ ...p, days_left: daysUntil(p.membership_expires) }))
    .filter((p) => p.days_left != null && p.days_left <= days)
    .sort((a, b) => (a.days_left - b.days_left)
      || a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
}

module.exports = { normalizeDateCell, daysUntil, expiringPeople };
