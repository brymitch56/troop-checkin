'use strict';
// Messaging opt-in trackers. Youth consent lives on the person_guardian link
// (strictly opt-in; see notifySweep.js) — these queries only READ it:
//   - "no opt-in on file": active youth where every authorized guardian link
//     is still 'unknown' (the family never returned the messaging form) —
//     youth with no authorized guardians at all count too (equally unreachable;
//     guardian_count lets the UI flag them).
//   - "declined": active youth with at least one authorized 'stop' link and
//     no authorized 'yes'. A mixed family (one yes-parent + one stop-parent)
//     is messageable and appears in NEITHER list (agreed 2026-08-29).
// Adults carry their own consent on person.sms_opt_in (migration 010).
const { db } = require('../db');

const youthCols = `y.id, y.is_youth, y.member_id, y.first_name, y.last_name,
                   y.nickname, y.patrol, y.level,
                   (SELECT COUNT(*) FROM person_guardian pg
                     WHERE pg.youth_id = y.id AND pg.authorized = 1) AS guardian_count`;

function youthNoOptIn() {
  return db.prepare(
    `SELECT ${youthCols} FROM person y
      WHERE y.is_youth = 1 AND y.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM person_guardian pg
                         WHERE pg.youth_id = y.id AND pg.authorized = 1
                           AND pg.sms_opt_in != 'unknown')
      ORDER BY y.last_name, y.first_name`
  ).all();
}

function youthDeclined() {
  return db.prepare(
    `SELECT ${youthCols} FROM person y
      WHERE y.is_youth = 1 AND y.status = 'active'
        AND EXISTS (SELECT 1 FROM person_guardian pg
                     WHERE pg.youth_id = y.id AND pg.authorized = 1
                       AND pg.sms_opt_in = 'stop')
        AND NOT EXISTS (SELECT 1 FROM person_guardian pg
                         WHERE pg.youth_id = y.id AND pg.authorized = 1
                           AND pg.sms_opt_in = 'yes')
      ORDER BY y.last_name, y.first_name`
  ).all();
}

// Adults by their own consent state ('unknown' or 'stop'). Shown as a
// separate section in the reports — adult consent is new (migration 010) and
// every adult starts 'unknown', so these lists start large by design.
function adultsByOptIn(state) {
  return db.prepare(
    `SELECT id, is_youth, member_id, first_name, last_name, nickname, role,
            phone_mobile, sms_opt_in
       FROM person
      WHERE is_youth = 0 AND status = 'active' AND sms_opt_in = ?
      ORDER BY last_name, first_name`
  ).all(state);
}

module.exports = { youthNoOptIn, youthDeclined, adultsByOptIn };
