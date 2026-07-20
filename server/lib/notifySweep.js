'use strict';
// Notification sweep (Phase 3). Finds youth still signed in past event end +
// grace period and texts the primary authorized guardian. One notification
// per youth/guardian/event. Entirely OFF unless SMS_ENABLED=true; without
// Twilio credentials it records rows with status 'failed' rather than lying.
const { db } = require('../db');
const env = require('./env');
const sms = require('./sms');

const DEFAULT_GRACE_MIN = 30;

function findLingering(now = new Date()) {
  return db.prepare(
    `SELECT p.id AS person_id, p.first_name, p.last_name, p.nickname,
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

async function sweep() {
  const lingering = findLingering();
  let recorded = 0, sent = 0;
  for (const row of lingering) {
    const guardians = db.prepare(
      `SELECT pg.guardian_id, g.phone_mobile, g.first_name
         FROM person_guardian pg JOIN person g ON g.id = pg.guardian_id
        WHERE pg.youth_id = ? AND pg.authorized = 1 AND pg.sms_opt_in != 'stop'
          AND g.status != 'merged'
        ORDER BY pg.is_primary DESC, (g.phone_mobile IS NULL) LIMIT 1`).all(row.person_id);
    for (const g of guardians) {
      const dup = db.prepare(
        `SELECT 1 FROM notification
          WHERE person_id = ? AND guardian_id = ? AND event_id = ? LIMIT 1`
      ).get(row.person_id, g.guardian_id, row.event_id);
      if (dup) continue;

      let status = 'failed', sid = null;
      if (sms.configured() && g.phone_mobile) {
        const name = row.nickname || row.first_name;
        const body = `${env.TROOP_ID}: ${name} ${row.last_name} is still checked in after "${row.title}" ended. ` +
          `Reply Y once picked up, or contact the leaders. Reply STOP to opt out.`;
        try {
          const r = await sms.send(g.phone_mobile, body);
          status = 'sent'; sid = r.sid; sent++;
        } catch (e) {
          console.error(`sms to guardian #${g.guardian_id} failed:`, e.message);
        }
      }
      db.prepare(
        `INSERT INTO notification (person_id, guardian_id, event_id, channel, status, twilio_sid)
         VALUES (?, ?, ?, 'sms', ?, ?)`
      ).run(row.person_id, g.guardian_id, row.event_id, status, sid);
      recorded++;
    }
  }
  return { lingering: lingering.length, recorded, sent };
}

function scheduleSweep() {
  if (!env.SMS_ENABLED) return null; // default: off
  const timer = setInterval(() => {
    sweep().catch((e) => console.error('notify sweep failed:', e.message));
  }, 5 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { sweep, findLingering, scheduleSweep };
