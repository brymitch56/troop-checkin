'use strict';
// SMS notifications — STRICTLY OPT-IN. A guardian is texted only when the
// youth↔guardian link has sms_opt_in='yes' (set in admin with a stored,
// signed consent form). 'unknown' is never texted; 'stop' never texted.
// Used by both the automatic sweep (lingering youth after event end + grace)
// and the kiosk "text guardians" button (routes/api.js /notify-onsite).
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

// Best opted-in guardian for a youth: authorized, sms_opt_in='yes', has a
// mobile; primary preferred. Returns undefined when nobody qualifies.
function pickGuardian(youthId) {
  return db.prepare(
    `SELECT pg.guardian_id, g.phone_mobile,
            g.first_name || ' ' || g.last_name AS guardian_name
       FROM person_guardian pg JOIN person g ON g.id = pg.guardian_id
      WHERE pg.youth_id = ? AND pg.authorized = 1 AND pg.sms_opt_in = 'yes'
        AND g.status != 'merged' AND g.phone_mobile IS NOT NULL AND g.phone_mobile != ''
      ORDER BY pg.is_primary DESC LIMIT 1`).get(youthId);
}

// Notify one youth's guardian about one event. Dedupes per
// youth/guardian/event via the notification table. Returns a result object —
// never throws for per-youth conditions.
async function notifyYouth(row) {
  const youthName = `${row.nickname || row.first_name} ${row.last_name}`;
  const g = pickGuardian(row.person_id);
  if (!g) {
    return { youth: youthName, status: 'skipped', reason: 'no opted-in guardian with a mobile number — contact another way' };
  }
  const dup = db.prepare(
    `SELECT 1 FROM notification
      WHERE person_id = ? AND guardian_id = ? AND event_id = ? LIMIT 1`
  ).get(row.person_id, g.guardian_id, row.event_id);
  if (dup) return { youth: youthName, guardian: g.guardian_name, status: 'skipped', reason: 'already notified for this event' };

  let status = 'failed', sid = null;
  if (sms.configured()) {
    const body = `${env.TROOP_ID}: ${youthName} is still checked in after "${row.title}" ended. ` +
      `Reply Y once picked up, or contact the leaders. Reply STOP to opt out.`;
    try {
      const r = await sms.send(g.phone_mobile, body);
      status = 'sent'; sid = r.sid;
    } catch (e) {
      console.error(`sms to guardian #${g.guardian_id} failed:`, e.message);
    }
  }
  db.prepare(
    `INSERT INTO notification (person_id, guardian_id, event_id, channel, status, twilio_sid)
     VALUES (?, ?, ?, 'sms', ?, ?)`
  ).run(row.person_id, g.guardian_id, row.event_id, status, sid);
  return { youth: youthName, guardian: g.guardian_name, status,
           ...(status === 'failed' ? { reason: 'send failed — see server log' } : {}) };
}

async function sweep() {
  const lingering = findLingering();
  let recorded = 0, sent = 0;
  for (const row of lingering) {
    const r = await notifyYouth(row);
    if (r.status === 'sent') { sent++; recorded++; }
    else if (r.status === 'failed') recorded++;
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

module.exports = { sweep, findLingering, pickGuardian, notifyYouth, scheduleSweep };
