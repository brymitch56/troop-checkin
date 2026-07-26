'use strict';
// Twilio inbound webhook (Phase 3). Configure in the Twilio console:
//   Phone number → Messaging → "A message comes in" → Webhook (POST)
//   URL: <PUBLIC_URL>/api/sms/inbound
// Requests are authenticated via the X-Twilio-Signature header — no session.
const express = require('express');
const { db } = require('../db');
const env = require('../lib/env');
const sms = require('../lib/sms');

const router = express.Router();

const twiml = (res, message) => {
  res.set('Content-Type', 'text/xml');
  res.send(message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response/>`);
};

router.post('/inbound', express.urlencoded({ extended: false }), (req, res) => {
  if (!env.SMS_ENABLED) return res.status(404).end();
  if (!env.PUBLIC_URL) return res.status(503).end(); // can't validate without the public URL
  const url = `${env.PUBLIC_URL}/api/sms/inbound`;
  if (!sms.validateSignature(req.headers['x-twilio-signature'], url, req.body)) {
    return res.status(403).end();
  }

  const from = sms.normPhone(req.body.From);
  const rawBody = String(req.body.Body || '').trim();
  const text = rawBody.toUpperCase();
  if (!from) return twiml(res);

  // guardian rows whose adult's mobile matches the sender
  const guardianRows = db.prepare(
    `SELECT pg.youth_id, pg.guardian_id FROM person_guardian pg
       JOIN person g ON g.id = pg.guardian_id
      WHERE g.status != 'merged' AND g.phone_mobile IS NOT NULL`
  ).all().filter((r) => {
    const g = db.prepare('SELECT phone_mobile FROM person WHERE id = ?').get(r.guardian_id);
    return sms.normPhone(g.phone_mobile) === from;
  });

  // every inbound message goes in the viewable log (keyword or not)
  const isKeyword = ['Y', 'YES', 'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
    'START', 'UNSTOP', 'SUBSCRIBE', 'HELP'].includes(text);
  db.prepare(
    `INSERT INTO sms_message (direction, kind, guardian_id, phone, body, twilio_sid, status)
     VALUES ('in', ?, ?, ?, ?, ?, 'received')`
  ).run(isKeyword ? 'keyword' : 'reply',
        guardianRows.length ? guardianRows[0].guardian_id : null,
        String(req.body.From || ''), rawBody, req.body.MessageSid || null);

  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(text)) {
    for (const r of guardianRows) {
      db.prepare(`UPDATE person_guardian SET sms_opt_in = 'stop' WHERE youth_id = ? AND guardian_id = ?`)
        .run(r.youth_id, r.guardian_id);
    }
    return twiml(res); // Twilio sends its own STOP confirmation
  }
  if (['START', 'UNSTOP', 'SUBSCRIBE'].includes(text)) {
    // START restores a previous opt-in after a STOP; it never creates consent
    // out of thin air ('unknown' pairs stay unknown until the signed form is
    // recorded in admin).
    for (const r of guardianRows) {
      db.prepare(`UPDATE person_guardian SET sms_opt_in = 'yes'
                   WHERE youth_id = ? AND guardian_id = ? AND sms_opt_in = 'stop' AND consent_form_id IS NOT NULL`)
        .run(r.youth_id, r.guardian_id);
    }
    return twiml(res);
  }

  if (text === 'Y' || text === 'YES') {
    // close open sign-ins for this guardian's notified youth
    const closed = [];
    const run = db.transaction(() => {
      for (const r of guardianRows) {
        const open = db.prepare(
          `SELECT tp.txn_id AS in_txn_id, t.event_id, t.staff_id,
                  p.first_name, p.last_name, p.nickname
             FROM txn_person tp
             JOIN txn t ON t.id = tp.txn_id
             JOIN person p ON p.id = tp.person_id
            WHERE tp.person_id = ? AND tp.open = 1 AND t.voided_by_txn_id IS NULL`
        ).get(r.youth_id);
        if (!open) continue;
        const notified = db.prepare(
          `SELECT id FROM notification
            WHERE person_id = ? AND guardian_id = ? AND event_id = ?
              AND kind = 'lingering' AND status IN ('sent', 'delivered')`
        ).get(r.youth_id, r.guardian_id, open.event_id);
        if (!notified) continue; // only close what we actually asked about
        const t = db.prepare(
          `INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id,
                            signer_person_id, close_method)
           VALUES (?, ?, 'out', ?, ?, ?, 'sms_confirm')`
        ).run(`sms-${r.youth_id}-${Date.now()}`, open.event_id, new Date().toISOString(),
              open.staff_id, r.guardian_id);
        db.prepare(`INSERT INTO txn_person (txn_id, person_id, open, in_txn_id) VALUES (?, ?, 0, ?)`)
          .run(Number(t.lastInsertRowid), r.youth_id, open.in_txn_id);
        db.prepare('UPDATE txn_person SET open = 0 WHERE txn_id = ? AND person_id = ?')
          .run(open.in_txn_id, r.youth_id);
        db.prepare(`UPDATE notification SET status = 'replied_y' WHERE id = ?`).run(notified.id);
        closed.push(open.nickname || open.first_name);
      }
    });
    run();
    return twiml(res, closed.length
      ? `Thanks — ${closed.join(', ')} marked as picked up.`
      : 'No open check-ins were waiting on you. If something looks wrong, please contact the leaders.');
  }

  // Non-keyword text (e.g. a reply to an ETA broadcast): it's logged above for
  // leaders to read in Admin → Messages. Only send the Y-hint when this sender
  // actually has a pickup confirmation pending — otherwise stay quiet instead
  // of robo-nagging someone who just wrote "thanks".
  const hasPending = guardianRows.some((r) => db.prepare(
    `SELECT 1 FROM notification n
       JOIN txn_person tp ON tp.person_id = n.person_id AND tp.open = 1
       JOIN txn t ON t.id = tp.txn_id AND t.voided_by_txn_id IS NULL
      WHERE n.guardian_id = ? AND n.person_id = ? AND n.kind = 'lingering'
        AND n.status IN ('sent', 'delivered') LIMIT 1`
  ).get(r.guardian_id, r.youth_id));
  if (hasPending) {
    return twiml(res, `Reply Y to confirm pickup, or STOP to opt out of ${env.TROOP_ID} alerts.`);
  }
  return twiml(res);
});

// Twilio delivery-status callbacks (sent -> delivered/undelivered/failed).
// Configured automatically on every send when PUBLIC_URL is set.
router.post('/status', express.urlencoded({ extended: false }), (req, res) => {
  if (!env.SMS_ENABLED || !env.PUBLIC_URL) return res.status(404).end();
  const url = `${env.PUBLIC_URL}/api/sms/status`;
  if (!sms.validateSignature(req.headers['x-twilio-signature'], url, req.body)) {
    return res.status(403).end();
  }
  const sid = req.body.MessageSid, st = req.body.MessageStatus;
  if (sid && st) {
    db.prepare('UPDATE sms_message SET status = ? WHERE twilio_sid = ?').run(st, sid);
    if (st === 'delivered') {
      db.prepare(`UPDATE notification SET status = 'delivered' WHERE twilio_sid = ? AND status = 'sent'`).run(sid);
    } else if (st === 'failed' || st === 'undelivered') {
      db.prepare(`UPDATE notification SET status = 'failed' WHERE twilio_sid = ? AND status IN ('sent')`).run(sid);
    }
  }
  res.status(204).end();
});

module.exports = router;
