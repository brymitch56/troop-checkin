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

// ------------------------------------------------------ recipient mode -----
// meta key 'sms_recipients' — {mode: 'primary' | 'all'} (decided 2026-09-01):
//   primary = ONE guardian per youth (the primary if eligible, else the first
//             eligible in a DETERMINISTIC order) — the original behavior;
//   all     = every eligible guardian of the youth. Consent is per adult
//             either way: a guardian is eligible only when THEIR OWN link is
//             opted in with a stored form, so 'all' never widens consent —
//             it stops skipping adults who already gave it.
// Default 'primary' so a deploy changes nothing until an admin flips it.
const RECIPIENTS_KEY = 'sms_recipients';
function getRecipientMode() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(RECIPIENTS_KEY);
  try { return row && JSON.parse(row.value).mode === 'all' ? 'all' : 'primary'; }
  catch { return 'primary'; }
}
function saveRecipientMode(mode) {
  const v = { mode: mode === 'all' ? 'all' : 'primary' };
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(RECIPIENTS_KEY, JSON.stringify(v));
  return v.mode;
}

// Eligible guardians of a youth: authorized + opted in (own link) + has a
// mobile. Deterministic order: primary first, then by name, then link id —
// so "primary" mode's fallback is predictable, not row-order luck.
function eligibleGuardians(youthId) {
  return db.prepare(
    `SELECT pg.guardian_id, g.phone_mobile,
            g.first_name || ' ' || g.last_name AS guardian_name
       FROM person_guardian pg JOIN person g ON g.id = pg.guardian_id
      WHERE pg.youth_id = ? AND pg.authorized = 1 AND pg.sms_opt_in = 'yes'
        AND g.status != 'merged' AND g.phone_mobile IS NOT NULL AND g.phone_mobile != ''
      ORDER BY pg.is_primary DESC, g.last_name, g.first_name, pg.guardian_id`).all(youthId);
}

// Recipients for a youth under a mode. Returns [] when nobody qualifies.
function recipientsFor(youthId, mode = getRecipientMode()) {
  const all = eligibleGuardians(youthId);
  return mode === 'all' ? all : all.slice(0, 1);
}

// Back-compat: the one guardian "primary" mode would text (or undefined).
function pickGuardian(youthId) {
  return recipientsFor(youthId, 'primary')[0];
}

const youthName = (row) => `${row.nickname || row.first_name} ${row.last_name}`;

// Group eligible rows by guardian. `dedupe` (lingering only) drops youth
// already notified for their event. `mode` picks one or all eligible
// guardians per youth; one text per guardian either way (a parent with
// three kids on site still gets ONE message). Returns { groups, skipped }.
function groupByGuardian(rows, { dedupe, mode = getRecipientMode() }) {
  const groups = new Map();
  const skipped = [];
  for (const row of rows) {
    const name = youthName(row);
    const recipients = recipientsFor(row.person_id, mode);
    if (!recipients.length) {
      skipped.push({ youth: name, reason: 'no opted-in guardian with a mobile number — contact another way' });
      continue;
    }
    let reached = 0;
    for (const g of recipients) {
      if (dedupe) {
        const dup = db.prepare(
          `SELECT 1 FROM notification
            WHERE person_id = ? AND guardian_id = ? AND event_id = ? AND kind = 'lingering' LIMIT 1`
        ).get(row.person_id, g.guardian_id, row.event_id);
        if (dup) continue;
      }
      if (!groups.has(g.guardian_id)) groups.set(g.guardian_id, { ...g, rows: [], names: [] });
      const grp = groups.get(g.guardian_id);
      grp.rows.push(row);
      grp.names.push(name);
      reached++;
    }
    if (dedupe && !reached) skipped.push({ youth: name, reason: 'already notified for this event' });
  }
  return { groups, skipped };
}

// Send one text per guardian group; record one notification row per youth and
// one sms_message row per actual message (the viewable log).
async function sendGroups(groups, kind, bodyFor) {
  const sent = [], failed = [];
  let recorded = 0, sentCount = 0;
  for (const grp of groups.values()) {
    let status = 'failed', sid = null;
    const body = bodyFor(grp);
    if (sms.configured()) {
      try {
        const r = await sms.send(grp.phone_mobile, body);
        status = 'sent'; sid = r.sid; sentCount++;
      } catch (e) {
        console.error(`sms to guardian #${grp.guardian_id} failed:`, e.message);
      }
    }
    db.prepare(
      `INSERT INTO sms_message (direction, kind, guardian_id, phone, body, twilio_sid, status)
       VALUES ('out', ?, ?, ?, ?, ?, ?)`
    ).run(kind, grp.guardian_id, grp.phone_mobile, body, sid, status);
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
async function notifyLingering(rows, opts = {}) {
  const { groups, skipped } = groupByGuardian(rows, { dedupe: true, mode: opts.mode });
  const r = await sendGroups(groups, 'lingering', lingeringBody);
  return { sent: r.sent, skipped: [...skipped, ...r.failed], recorded: r.recorded, sentCount: r.sentCount };
}

// Custom broadcast (ETA updates etc.) — repeatable, no dedupe, never closes
// sign-ins. One text per guardian regardless of how many youth they cover.
// opts.mode overrides the global recipient mode for this one broadcast.
async function messageGuardians(rows, message, opts = {}) {
  const { groups, skipped } = groupByGuardian(rows, { dedupe: false, mode: opts.mode });
  const body = `${env.TROOP_ID}: ${message} — Reply STOP to opt out.`;
  const r = await sendGroups(groups, 'custom', () => body);
  return { sent: r.sent, skipped: [...skipped, ...r.failed], recorded: r.recorded, sentCount: r.sentCount };
}

// Broadcast directly to ADULTS (their own consent, person.sms_opt_in —
// migration 010). Used only when a leader explicitly ticks "include adults"
// on an adult-tracked event's broadcast; never touches the youth/guardian
// path above. Strictly opt-in: 'unknown' and 'stop' are skipped by name so
// the leader knows exactly who was not reached.
async function messageAdults(personIds, message) {
  const body = `${env.TROOP_ID}: ${message} — Reply STOP to opt out.`;
  const sent = [], skipped = [];
  for (const id of [...new Set(personIds)]) {
    const a = db.prepare(
      `SELECT id, first_name, last_name, nickname, phone_mobile, sms_opt_in
         FROM person WHERE id = ? AND is_youth = 0 AND status != 'merged'`).get(id);
    if (!a) continue;
    const name = `${a.nickname || a.first_name} ${a.last_name}`;
    if (a.sms_opt_in !== 'yes') {
      skipped.push({ adult: name, reason: 'adult has not opted in — contact another way' });
      continue;
    }
    if (!a.phone_mobile) {
      skipped.push({ adult: name, reason: 'no mobile number on file' });
      continue;
    }
    let status = 'failed', sid = null;
    if (sms.configured()) {
      try {
        const r = await sms.send(a.phone_mobile, body);
        status = 'sent'; sid = r.sid;
      } catch (e) {
        console.error(`sms to adult #${a.id} failed:`, e.message);
      }
    }
    db.prepare(
      `INSERT INTO sms_message (direction, kind, guardian_id, phone, body, twilio_sid, status)
       VALUES ('out', 'custom', ?, ?, ?, ?, ?)`
    ).run(a.id, a.phone_mobile, body, sid, status);
    if (status === 'sent') sent.push({ adult: name });
    else skipped.push({ adult: name, reason: 'send failed — see server log' });
  }
  return { sent, skipped, sentCount: sent.length };
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
  sweep, findLingering, pickGuardian, eligibleGuardians, recipientsFor,
  getRecipientMode, saveRecipientMode,
  notifyLingering, messageGuardians, messageAdults, scheduleSweep,
};
