'use strict';
// Phase 3 groundwork, shipped OFF by default (SMS_ENABLED=false).
// The sweep finds youth still signed in past event end + grace period and
// records a notification row per youth/guardian/event. Actual SMS delivery
// is deliberately not implemented until Twilio A2P 10DLC registration is
// done — with SMS_ENABLED unset this module is never scheduled.
const { db } = require('../db');
const env = require('./env');

const DEFAULT_GRACE_MIN = 30;

function findLingering(now = new Date()) {
  return db.prepare(
    `SELECT p.id AS person_id, p.first_name, p.last_name,
            e.id AS event_id, e.title, e.end_at,
            COALESCE(e.notify_after_min, ?) AS grace_min
       FROM txn_person tp
       JOIN txn t ON t.id = tp.txn_id
       JOIN person p ON p.id = tp.person_id
       JOIN event e ON e.id = t.event_id
      WHERE tp.open = 1 AND t.voided_by_txn_id IS NULL AND p.is_youth = 1
        AND datetime(e.end_at, '+' || COALESCE(e.notify_after_min, ?) || ' minutes')
            <= datetime(?)`
  ).all(DEFAULT_GRACE_MIN, DEFAULT_GRACE_MIN, now.toISOString());
}

function sweep() {
  const lingering = findLingering();
  let recorded = 0;
  for (const row of lingering) {
    const guardians = db.prepare(
      `SELECT pg.guardian_id FROM person_guardian pg
        WHERE pg.youth_id = ? AND pg.authorized = 1 AND pg.sms_opt_in != 'stop'
        ORDER BY pg.is_primary DESC LIMIT 1`).all(row.person_id);
    for (const g of guardians) {
      const dup = db.prepare(
        `SELECT 1 FROM notification
          WHERE person_id = ? AND guardian_id = ? AND event_id = ? LIMIT 1`
      ).get(row.person_id, g.guardian_id, row.event_id);
      if (dup) continue; // one notification per youth/guardian/event
      db.prepare(
        `INSERT INTO notification (person_id, guardian_id, event_id, channel, status)
         VALUES (?, ?, ?, 'sms', 'sent')`
      ).run(row.person_id, g.guardian_id, row.event_id);
      // TODO(Phase 3): actual Twilio send + delivery status callback here.
      recorded++;
    }
  }
  return { lingering: lingering.length, recorded };
}

function scheduleSweep() {
  if (!env.SMS_ENABLED) return null; // default: off
  const timer = setInterval(() => {
    try { sweep(); } catch (e) { console.error('notify sweep failed:', e.message); }
  }, 5 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { sweep, findLingering, scheduleSweep };
