'use strict';
// SMS notifications — STRICTLY OPT-IN. A guardian is texted only when the
// youth↔guardian link has sms_opt_in='yes' (set in admin with a stored,
// signed consent form). 'unknown' is never texted; 'stop' never texted.
//
// Grouping: exactly ONE text per guardian per run — a parent with several
// lingering youth gets a single message listing all of them, and their Y
// reply closes all of them (webhook matches every notified open youth).
// Exactly one guardian per youth is contacted: the primary if eligible,
// otherwise the next opted-in authorized guardian with a mobile.
//
// Used by the automatic sweep, the kiosk "Text guardians" button, and the
// kiosk custom-broadcast button (routes/api.js).
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

// The one guardian who gets texted for a youth: authorized + opted in + has a
// mobile, primary preferred. Returns undefined when nobody qualifies.
function pickGuardian(youthId) {
  return db.prepare(
    `SELECT pg.guardian_id, g.phone_mobile,
            g.first_name || ' ' || g.last_name AS guardian_name
       FROM person_guardian pg JOIN person g ON g.id = pg.guardian_id
      WHERE pg.youth_id = ? AND pg.authorized = 1 AND pg.sms_opt_in = 'yes'
        AND g.status != 'merged' AND g.phone_mobile IS NOT NULL AND g.phone_mobile != ''
      ORDER BY pg.is_primary DESC LIMIT 1`).get(youthId);
}

const youthName = (row) => `${row.nickname || row.first_name} ${row.last_name}`;

// Group eligible rows by guardian. `dedupe` (lingering only) drops youth
// already notified for their event. Returns { groups: Map, skipped: [] }.
function groupByGuardian(rows, { dedupe }) {
  const groups = new Map();
  const skipped = [];
  for (const row of rows) {
    const name = youthName(row);
    const g = pickGuardian(row.person_id);
    if (!g) {
      skipped.push({ youth: name, reason: 'no opted-in guardian with a mobile number — contact another way' });
      continue;
    }
    if (dedupe) {
      const dup = db.prepare(
        `SELECT 1 FROM notification
          WHERE person_id = ? AND guardian_id = ? AND event_id = ? AND kind = 'lingering' LIMIT 1`
      ).get(row.person_id, g.guardian_id, row.event_id);
      if (dup) { skipped.push({ youth: name, reason: 'already notified for this event' }); continue; }
    }
    if (!groups.has(g.guardian_id)) groups.set(g.guardian_id, { ...g, rows: [], names: [] });
    const grp = groups.get(g.guardian_id);
    grp.rows.push(row);
    grp.names.push(name);
  }
  return { groups, skipped };
}

// Send one text per guardian group; record one notification row per youth.
async function sendGroups(groups, kind, bodyFor) {
  const sent = [], failed = [];
  let recorded = 0, sentCount = 0;
  for (const grp of groups.values()) {
    let status = 'failed', sid = null;
    if (sms.configured()) {
      try {
        const r = await sms.send(grp.phone_mobile, bodyFor(grp));
        status = 'sent'; sid = r.sid; sentCount++;
      } catch (e) {
        console.error(`sms to guardian #${grp.guardian_id} failed:`, e.message);
      }
    }
    for (const row of grp.rows) {
      db.prepare(
        `INSERT INTO notification (person_id, guardian_id, event_id, channel, status, twilio_sid, kind)
         VALUES (?, ?, ?, 'sms', ?, ?, ?)`
      ).run(row.person_id, grp.guardian_id, row.event_id, status, sid, kind);
      recorded++;
    }
    (status === 'sent' ? sent : failed)
      .push({ guardian: grp.guardian_name, youths: grp.names,
              ...(status === 'sent' ? {} : { reason: 'send failed — see server log' }) });
  }
  return { sent, failed, recorded, sentCount };
}

function lingeringBody(grp) {
  const events = [...new Set(grp.rows.map((r) => r.title))];
  const names = grp.names.join(', ');
  const verb = grp.names.length > 1 ? 'are' : 'is';
  const after = events.length === 1 ? `"${events[0]}" ended` : 'your events ended';
  return `${env.TROOP_ID}: ${names} ${verb} still checked in after ${after}. ` +
    `Reply Y once picked up, or contact the leaders. Reply STOP to opt out.`;
}

// Lingering alerts (deduped, Y-closeable). rows: person_id/names/event_id/title.
async function notifyLingering(rows) {
  const { groups, skipped } = groupByGuardian(rows, { dedupe: true });
  const r = await sendGroups(groups, 'lingering', lingeringBody);
  return { sent: r.sent, skipped: [...skipped, ...r.failed], recorded: r.recorded, sentCount: r.sentCount };
}

// Custom broadcast (ETA updates etc.) — repeatable, no dedupe, never closes
// sign-ins. One text per guardian regardless of how many youth they cover.
async function messageGuardians(rows, message) {
  const { groups, skipped } = groupByGuardian(rows, { dedupe: false });
  const body = `${env.TROOP_ID}: ${message} — Reply STOP to opt out.`;
  const r = await sendGroups(groups, 'custom', () => body);
  return { sent: r.sent, skipped: [...skipped, ...r.failed], recorded: r.recorded, sentCount: r.sentCount };
}

async function sweep() {
  const lingering = findLingering();
  const r = await notifyLingering(lingering);
  return { lingering: lingering.length, recorded: r.recorded, sent: r.sentCount };
}

function scheduleSweep() {
  if (!env.SMS_ENABLED) return null; // default: off
  const timer = setInterval(() => {
    sweep().catch((e) => console.error('notify sweep failed:', e.message));
  }, 5 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = {
  sweep, findLingering, pickGuardian, notifyLingering, messageGuardians, scheduleSweep,
};
