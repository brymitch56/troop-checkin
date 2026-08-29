'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db, SIG_DIR, UPLOAD_DIR } = require('../db');
const auth = require('../auth');
const roster = require('../lib/rosterImport');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------------------------------------------------------------- auth ----
router.get('/staff-list', (req, res) => {
  // kiosk login picker: names only. has_pin drives the input type client-side
  // (admins without a PIN type their password; a set PIN overrides it).
  res.json(db.prepare(
    `SELECT id, name, role, pin_hash IS NOT NULL AS has_pin
       FROM staff WHERE active = 1 ORDER BY name`).all());
});

router.post('/login', express.json(), (req, res) => {
  const { staff_id, pin } = req.body || {};
  const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').get(staff_id);
  const hash = staff && (staff.pin_hash || staff.password_hash);
  if (!staff || !auth.verifySecret(pin, hash)) {
    return res.status(401).json({ error: 'Wrong PIN. Try again.' });
  }
  const sess = auth.createSession(staff.id, staff.role);
  auth.setSessionCookie(res, sess.token, req.secure); // Secure when served over the tunnel (HTTPS)
  // session_expires_at: the client caches it as the offline-validity window —
  // the kiosk may be entered without a server round-trip until then
  res.json({ id: staff.id, name: staff.name, role: staff.role, session_expires_at: sess.expires_at });
});

router.post('/logout', (req, res) => {
  const sess = auth.sessionFromRequest(req);
  if (sess) auth.destroySession(sess.token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const sess = auth.sessionFromRequest(req);
  if (!sess) return res.status(401).json({ error: 'Not signed in.' });
  res.json({
    id: sess.staff_id, name: sess.name, role: sess.role,
    session_expires_at: sess.expires_at.replace(' ', 'T') + 'Z',
  });
});

// everything below requires a door session
router.use(auth.requireAuth('door'));

// -------------------------------------------------------------- people ----
const OPEN_INFO_SQL = `
  SELECT tp.txn_id AS in_txn_id, t.event_id, e.title AS event_title
    FROM txn_person tp
    JOIN txn t ON t.id = tp.txn_id
    JOIN event e ON e.id = t.event_id
   WHERE tp.person_id = ? AND tp.open = 1 AND t.voided_by_txn_id IS NULL
   LIMIT 1`;

// all concurrent opens (someone signed into two overlapping events at once)
const OPEN_ALL_SQL = `
  SELECT tp.txn_id AS in_txn_id, t.event_id, e.title AS event_title
    FROM txn_person tp
    JOIN txn t ON t.id = tp.txn_id
    JOIN event e ON e.id = t.event_id
   WHERE tp.person_id = ? AND tp.open = 1 AND t.voided_by_txn_id IS NULL
   ORDER BY datetime(e.start_at)`;

function personView(p) {
  if (!p) return null;
  const open = db.prepare(OPEN_INFO_SQL).get(p.id) || null;
  return {
    id: p.id, is_youth: !!p.is_youth, member_id: p.member_id,
    first_name: p.first_name, last_name: p.last_name, nickname: p.nickname,
    patrol: p.patrol, level: p.level, status: p.status, photo_path: p.photo_path,
    membership_expires: p.membership_expires, // kiosk expiry warning (also in the offline snapshot)
    // kiosk form badges (flag-only, never block; also in the offline snapshot)
    health_form_date: p.health_form_date, high_risk_form_date: p.high_risk_form_date,
    last_emerg_phone_1: p.last_emerg_phone_1, last_emerg_phone_2: p.last_emerg_phone_2,
    // adult phone numbers ride along so the on-site emergency-contact view
    // works from the offline snapshot (staff-only, session-gated data)
    phone_mobile: p.phone_mobile, phone_home: p.phone_home,
    open, // null = not on site; else {in_txn_id, event_id, event_title}
  };
}

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT * FROM person
      WHERE status IN ('active','visitor')
        AND (first_name LIKE ? OR last_name LIKE ? OR nickname LIKE ?)
      ORDER BY is_youth DESC, last_name, first_name LIMIT 20`
  ).all(like, like, like);
  res.json(rows.map(personView));
});

router.get('/badge/:code', (req, res) => {
  const code = String(req.params.code).trim();
  const exact = db.prepare(`SELECT * FROM person WHERE badge_code = ? AND status != 'merged'`).get(code);
  if (exact) {
    // the badge payload carries the member's TLC hashid — backfill the
    // write-back mapping on scan if it's still empty (fill-only, never
    // overwrites a hand-set id)
    try { require('../lib/attendanceSync').adoptBadgeTlcId(exact.id, code); }
    catch (e) { console.error('[tlc-attendance] badge adopt failed:', e.message); }
    return res.json({ match: 'badge', person: personView(exact) });
  }
  // payload format "<memberID> | <token>" — reprinted badge: same ID, new token
  const memberId = code.split('|')[0].trim();
  if (memberId) {
    const byId = db.prepare(`SELECT * FROM person WHERE member_id = ? AND status != 'merged'`).get(memberId);
    if (byId) return res.json({ match: 'member', person: personView(byId) });
  }
  res.json({ match: 'none' });
});

router.post('/badge/link', express.json(), (req, res) => {
  const { person_id, code } = req.body || {};
  if (!person_id || !code) return res.status(400).json({ error: 'person_id and code are required.' });
  const taken = db.prepare('SELECT id FROM person WHERE badge_code = ?').get(code);
  if (taken && taken.id !== person_id) {
    return res.status(409).json({ error: 'That badge is already linked to someone else.' });
  }
  db.prepare(`UPDATE person SET badge_code = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(String(code).trim(), person_id);
  // new/reprinted badge = fresh TLC hashid straight from the card
  try { require('../lib/attendanceSync').adoptBadgeTlcId(person_id, code); }
  catch (e) { console.error('[tlc-attendance] badge adopt failed:', e.message); }
  res.json({ ok: true });
});

router.get('/person/:id/guardians', (req, res) => {
  const rows = db.prepare(
    `SELECT g.id, g.first_name, g.last_name, g.nickname, g.phone_mobile,
            pg.relationship, pg.authorized, pg.is_primary
       FROM person_guardian pg JOIN person g ON g.id = pg.guardian_id
      WHERE pg.youth_id = ? AND g.status != 'merged'
      ORDER BY pg.is_primary DESC, g.last_name, g.first_name`
  ).all(req.params.id);
  res.json(rows);
});

// quick-add: visitor youth (with guardian) or unregistered adult.
// Youth visitors REQUIRE the full contact set (name, guardian name, phone,
// email) — open-house follow-up depends on it. Adults need a name only.
router.post('/visitor', express.json(), (req, res) => {
  const { first_name, last_name, is_youth, guardian_name, guardian_phone, guardian_email, notes } = req.body || {};
  if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name are required.' });
  if (is_youth) {
    if (!String(guardian_name || '').trim() || !String(guardian_phone || '').trim() ||
        !String(guardian_email || '').trim()) {
      return res.status(400).json({ error: "Parent/guardian name, phone, AND email are all required for a youth visitor." });
    }
    if (!/^\S+@\S+\.\S+$/.test(String(guardian_email).trim())) {
      return res.status(400).json({ error: "That email doesn't look right — check it and try again." });
    }
  }
  const tx = db.transaction(() => {
    const p = db.prepare(
      `INSERT INTO person (is_youth, first_name, last_name, status, notes)
       VALUES (?, ?, ?, ?, ?)`
    ).run(is_youth ? 1 : 0, first_name.trim(), last_name.trim(), is_youth ? 'visitor' : 'active', notes || null);
    const pid = Number(p.lastInsertRowid);
    if (is_youth && guardian_name) {
      const parts = String(guardian_name).trim().split(/\s+/);
      const gfirst = parts.shift() || guardian_name;
      const glast = parts.join(' ') || last_name.trim();
      const g = db.prepare(
        `INSERT INTO person (is_youth, first_name, last_name, phone_mobile, email, status)
         VALUES (0, ?, ?, ?, ?, 'active')`
      ).run(gfirst, glast, guardian_phone || null, String(guardian_email || '').trim() || null);
      db.prepare(
        `INSERT INTO person_guardian (youth_id, guardian_id, authorized, is_primary, source)
         VALUES (?, ?, 1, 1, 'manual')`
      ).run(pid, Number(g.lastInsertRowid));
    }
    return pid;
  });
  const pid = tx();
  res.json({ person: personView(db.prepare('SELECT * FROM person WHERE id = ?').get(pid)) });
});

// -------------------------------------------------------------- events ----
// Auto-select window: an event is "matching" from 30 min BEFORE its start
// (early arrivals sign in) until 60 min AFTER its end (stragglers sign out).
// When several events match, suggestEvent picks the one whose "action
// moment" is nearest: sign-in rush before start, sign-out rush around the
// end — so a meeting that is mid-session loses to one about to start, and a
// meeting wrapping up (or just ended) wins back the kiosk.
const WINDOW_BEFORE = '-30 minutes';
const WINDOW_AFTER = '+60 minutes';

function suggestEvent(matching, now = new Date()) {
  if (!matching.length) return null;
  let best = null, bestScore = Infinity;
  for (const e of matching) {
    const start = new Date(e.start_at), end = new Date(e.end_at);
    const action = now < start ? start : end; // arriving → start; else → end
    const score = Math.abs(action - now);
    if (score < bestScore || (score === bestScore && start < new Date(best.start_at))) {
      best = e; bestScore = score;
    }
  }
  return best.id;
}

router.get('/events/current', (req, res) => {
  // datetime() normalizes both stored formats (ISO 'T'/'Z' and SQLite space
  // form) — raw string compares are wrong across the two.
  // "Past" is day-granular: a multi-day event whose finish DATE is today is
  // not past yet. Past events are returned but the client hides them behind
  // a toggle.
  const now = new Date().toISOString();
  const matching = db.prepare(
    `SELECT * FROM event
      WHERE datetime(start_at, ?) <= datetime(?) AND datetime(end_at, ?) >= datetime(?)
      ORDER BY datetime(start_at)`
  ).all(WINDOW_BEFORE, now, WINDOW_AFTER, now);
  // local_date() (see server/db.js) instead of date(x,'localtime'): SQLite's
  // 'localtime' ignores IANA TZ on Windows; the JS-backed function agrees
  // with JavaScript local time on every platform.
  const upcoming = db.prepare(
    `SELECT * FROM event
      WHERE NOT (datetime(start_at, ?) <= datetime(?) AND datetime(end_at, ?) >= datetime(?))
        AND local_date(end_at) >= local_date('now')
      ORDER BY datetime(start_at) LIMIT 20`
  ).all(WINDOW_BEFORE, now, WINDOW_AFTER, now);
  const past = db.prepare(
    `SELECT * FROM event
      WHERE local_date(end_at) < local_date('now')
      ORDER BY datetime(start_at) DESC LIMIT 20`
  ).all();
  res.json({ matching, upcoming, past, suggested_id: suggestEvent(matching) });
});

router.post('/events', express.json(), (req, res) => {
  const { title, start_at, end_at, location, track_adults, requires_high_adventure_form } = req.body || {};
  if (!title || !start_at || !end_at) {
    return res.status(400).json({ error: 'Title, start, and end are required.' });
  }
  const r = db.prepare(
    `INSERT INTO event (source, title, location, start_at, end_at, track_adults,
                        requires_high_adventure_form)
     VALUES ('manual', ?, ?, ?, ?, ?, ?)`
  ).run(title.trim(), location || null, start_at, end_at, track_adults ? 1 : 0,
        requires_high_adventure_form ? 1 : 0);
  res.json(db.prepare('SELECT * FROM event WHERE id = ?').get(Number(r.lastInsertRowid)));
});

// ---------------------------------------------------------------- txns ----
// POST /api/txn
// { client_uuid, direction: 'in'|'out', event_id (in only),
//   entries: [{person_id, emerg_phone_1?, emerg_phone_2?}],
//   signer_person_id? | signer_name_override?, force?,
//   signature_data? (dataURL; required when entries include youth),
//   signed_at }
router.post('/txn', express.json({ limit: '2mb' }), (req, res) => {
  const b = req.body || {};
  const entries = Array.isArray(b.entries) ? b.entries : [];
  if (!b.client_uuid || !entries.length || !['in', 'out'].includes(b.direction)) {
    return res.status(400).json({ error: 'client_uuid, direction, and entries are required.' });
  }

  const existing = db.prepare('SELECT id FROM txn WHERE client_uuid = ?').get(b.client_uuid);
  if (existing) return res.json({ ok: true, txn_id: existing.id, deduped: true });

  const people = entries.map((e) =>
    db.prepare('SELECT * FROM person WHERE id = ?').get(e.person_id)
  );
  if (people.some((p) => !p)) return res.status(400).json({ error: 'Unknown person in cart.' });
  const youthEntries = people.filter((p) => p.is_youth);

  // open-state validation (authoritative — protects against multi-station races)
  const opensOf = (pid) => db.prepare(OPEN_ALL_SQL).all(pid);
  // 'out' with several concurrent opens: which one this txn closes, per person
  const chosenOpen = new Map();
  if (b.direction === 'in') {
    // Same event twice is always a conflict. A DIFFERENT event is allowed —
    // overlapping events are real (a campout with a meeting inside it) — but
    // only after the kiosk confirms with allow_multi, so an accidental
    // double-tap still reads as "already signed in".
    const sameEvent = [], otherEvent = [];
    for (const p of people) {
      const opens = opensOf(p.id);
      if (!opens.length) continue;
      if (opens.some((o) => o.event_id === Number(b.event_id))) sameEvent.push(p);
      else otherEvent.push({ p, titles: opens.map((o) => o.event_title) });
    }
    if (sameEvent.length) {
      return res.status(409).json({
        error: 'Already signed in.',
        conflicts: sameEvent.map((p) => `${p.first_name} ${p.last_name}`),
      });
    }
    if (otherEvent.length && !b.allow_multi) {
      return res.status(409).json({
        error: 'Already signed into another event.',
        multi_open: otherEvent.map(({ p, titles }) =>
          ({ name: `${p.first_name} ${p.last_name}`, events: titles })),
      });
    }
    const event = b.event_id && db.prepare('SELECT * FROM event WHERE id = ?').get(b.event_id);
    if (!event) {
      return res.status(400).json({ error: 'A valid event is required for sign-in.' });
    }
    // FR-12: adults are only tracked at designated events
    if (!event.track_adults) {
      const adults = people.filter((p) => !p.is_youth).map((p) => `${p.first_name} ${p.last_name}`);
      if (adults.length) {
        return res.status(422).json({
          error: 'This event does not track adult attendance.', adults,
        });
      }
    }
  } else {
    // Close the right open when someone is signed into several events at
    // once: the kiosk's selected event wins; a person with exactly one open
    // needs no hint; several opens and no matching hint is an explicit error.
    const closed = [], ambiguous = [];
    for (const p of people) {
      const opens = opensOf(p.id);
      if (!opens.length) { closed.push(p); continue; }
      const hinted = b.event_id && opens.find((o) => o.event_id === Number(b.event_id));
      if (hinted) chosenOpen.set(p.id, hinted);
      else if (opens.length === 1) chosenOpen.set(p.id, opens[0]);
      else ambiguous.push({ p, titles: opens.map((o) => o.event_title) });
    }
    if (closed.length) {
      return res.status(409).json({
        error: 'Already signed out.',
        conflicts: closed.map((p) => `${p.first_name} ${p.last_name}`),
      });
    }
    if (ambiguous.length) {
      return res.status(409).json({
        error: 'Signed into more than one event — pick the event to sign out of, then try again.',
        multi_open: ambiguous.map(({ p, titles }) =>
          ({ name: `${p.first_name} ${p.last_name}`, events: titles })),
      });
    }
    const eventIds = [...new Set([...chosenOpen.values()].map((o) => o.event_id))];
    if (eventIds.length > 1) {
      return res.status(409).json({ error: 'These youth are signed into different events — sign them out separately.' });
    }
    b.event_id = eventIds[0];
  }

  // signer requirements (youth only; adult-only carts need no signer/signature)
  if (youthEntries.length) {
    if (!b.signer_person_id && !b.signer_name_override) {
      return res.status(400).json({ error: 'Select who is signing.' });
    }
    if (!b.signature_data) return res.status(400).json({ error: 'Signature is required.' });
    if (b.signer_person_id && !b.force) {
      const authorizedFor = db.prepare(
        `SELECT 1 FROM person_guardian WHERE youth_id = ? AND guardian_id = ? AND authorized = 1`
      );
      const unauthorized = youthEntries
        .filter((y) => !authorizedFor.get(y.id, b.signer_person_id))
        .map((y) => `${y.first_name} ${y.last_name}`);
      if (unauthorized.length) return res.status(422).json({ error: 'Signer not authorized.', unauthorized });
    }
  }

  // persist signature
  let sigPath = null;
  if (b.signature_data) {
    const m = /^data:image\/png;base64,(.+)$/.exec(b.signature_data);
    if (!m) return res.status(400).json({ error: 'Bad signature data.' });
    sigPath = path.join(SIG_DIR, `${b.client_uuid}.png`);
    fs.writeFileSync(sigPath, Buffer.from(m[1], 'base64'));
  }

  const write = db.transaction(() => {
    const t = db.prepare(
      `INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id,
                        signer_person_id, signer_name_override, signature_path, close_method, forced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      b.client_uuid, b.event_id, b.direction, b.signed_at || new Date().toISOString(),
      req.staff.staff_id, b.signer_person_id || null, b.signer_name_override || null,
      sigPath ? path.basename(sigPath) : null,
      b.direction === 'out' && youthEntries.length ? 'signature' : null,
      b.force ? 1 : 0
    );
    const txnId = Number(t.lastInsertRowid);

    for (const e of entries) {
      const open = b.direction === 'out' ? chosenOpen.get(e.person_id) : null;
      db.prepare(
        `INSERT INTO txn_person (txn_id, person_id, open, in_txn_id, emerg_phone_1, emerg_phone_2)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        txnId, e.person_id,
        b.direction === 'in' ? 1 : 0,
        open ? open.in_txn_id : null,
        e.emerg_phone_1 || null, e.emerg_phone_2 || null
      );
      if (b.direction === 'out' && open) {
        db.prepare('UPDATE txn_person SET open = 0 WHERE txn_id = ? AND person_id = ?')
          .run(open.in_txn_id, e.person_id);
      }
      if (b.direction === 'in' && (e.emerg_phone_1 || e.emerg_phone_2)) {
        db.prepare(
          `UPDATE person SET last_emerg_phone_1 = COALESCE(?, last_emerg_phone_1),
                             last_emerg_phone_2 = COALESCE(?, last_emerg_phone_2),
                             updated_at = datetime('now')
           WHERE id = ?`
        ).run(e.emerg_phone_1 || null, e.emerg_phone_2 || null, e.person_id);
      }
    }
    return txnId;
  });

  let txnId;
  try {
    txnId = write();
  } catch (err) {
    if (sigPath) fs.rmSync(sigPath, { force: true }); // don't orphan the signature PNG
    throw err;
  }

  // TLC write-back: SIGN-OUTS enqueue an Attended mark for the mapped TLC
  // event (lib/attendanceSync — off unless enabled in Admin → Import).
  // Recording at sign-out means the per-person "completed planned
  // requirements" answer rides along: unchecked pushes attendance WITHOUT
  // advancement (use_lesson_plans=0) for that person only. A background
  // sweep does the actual network push; this is one local INSERT and must
  // never break the kiosk response.
  if (b.direction === 'out') {
    try {
      require('../lib/attendanceSync').enqueue(b.event_id,
        entries.map((e) => ({ person_id: e.person_id, advancement: e.advancement !== false })));
    } catch (e) {
      console.error('[tlc-attendance] enqueue failed:', e.message);
    }
  }

  res.json({ ok: true, txn_id: txnId });
});

// offline-first roster snapshot (Phase 4): everything a kiosk needs to keep
// working without connectivity — people (with badge codes + open state),
// guardian links, and the event window. Stored client-side in IndexedDB.
router.get('/roster-snapshot', (req, res) => {
  const people = db.prepare(
    `SELECT * FROM person WHERE status IN ('active', 'visitor')`
  ).all().map(personView);
  const links = db.prepare(
    `SELECT pg.youth_id, pg.guardian_id, pg.relationship, pg.authorized, pg.is_primary
       FROM person_guardian pg
       JOIN person y ON y.id = pg.youth_id AND y.status != 'merged'
       JOIN person g ON g.id = pg.guardian_id AND g.status != 'merged'`
  ).all();
  const badges = db.prepare(
    `SELECT id, badge_code FROM person WHERE badge_code IS NOT NULL AND status != 'merged'`
  ).all();
  const now = new Date().toISOString();
  const events = db.prepare(
    `SELECT * FROM event
      WHERE datetime(end_at) >= datetime(?, '-12 hours')
        AND datetime(start_at) <= datetime(?, '+7 days')
      ORDER BY datetime(start_at)`
  ).all(now, now);
  res.json({ taken_at: now, people, links, badges, events });
});

// who's still here
router.get('/onsite', (req, res) => {
  const patrol = req.query.patrol ? String(req.query.patrol) : null;
  const rows = db.prepare(
    `SELECT p.id, p.first_name, p.last_name, p.nickname, p.patrol, p.is_youth,
            e.id AS event_id, e.title AS event_title, t.signed_at
       FROM txn_person tp
       JOIN txn t ON t.id = tp.txn_id
       JOIN person p ON p.id = tp.person_id
       JOIN event e ON e.id = t.event_id
      WHERE tp.open = 1 AND t.voided_by_txn_id IS NULL
        AND (? IS NULL OR p.patrol = ?)
      ORDER BY datetime(e.start_at), p.patrol, p.last_name, p.first_name`
  ).all(patrol, patrol);
  res.json(rows);
});

// Kiosk guardian texting. Strictly opt-in; ONE text per guardian even when
// they cover several on-site youth; the response tells the leader exactly who
// was NOT contacted and why, so they can phone those families instead.
const onsiteYouthRows = (patrol) => db.prepare(
  `SELECT p.id AS person_id, p.first_name, p.last_name, p.nickname,
          e.id AS event_id, e.title
     FROM txn_person tp
     JOIN txn t ON t.id = tp.txn_id
     JOIN person p ON p.id = tp.person_id
     JOIN event e ON e.id = t.event_id
    WHERE tp.open = 1 AND t.voided_by_txn_id IS NULL AND p.is_youth = 1
      AND (? IS NULL OR p.patrol = ?)`
).all(patrol, patrol);

router.post('/notify-onsite', express.json(), async (req, res) => {
  const sms = require('../lib/sms');
  const { notifyLingering } = require('../lib/notifySweep');
  if (!sms.configured()) {
    return res.status(503).json({ error: 'SMS is not set up yet — contact families directly.' });
  }
  const patrol = req.body && req.body.patrol ? String(req.body.patrol) : null;
  const rows = onsiteYouthRows(patrol);
  const r = await notifyLingering(rows);
  res.json({ onsite_youth: rows.length, sent: r.sent, skipped: r.skipped });
});

// Custom broadcast (ETA updates, "left a water bottle", etc.). Repeatable;
// never closes sign-ins. Two scopes:
//   onsite (default)  — guardians of youth currently checked in
//   attended          — guardians of every youth who signed into event_id
//                       today's run, even if already picked up
router.post('/message-onsite', express.json(), async (req, res) => {
  const sms = require('../lib/sms');
  const { messageGuardians } = require('../lib/notifySweep');
  if (!sms.configured()) {
    return res.status(503).json({ error: 'SMS is not set up yet — contact families directly.' });
  }
  const b = req.body || {};
  const message = String(b.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Type the message first.' });
  if (message.length > 300) return res.status(400).json({ error: 'Keep the message under 300 characters.' });
  const patrol = b.patrol ? String(b.patrol) : null;
  let rows;
  if (b.scope === 'attended') {
    if (!b.event_id) return res.status(400).json({ error: 'Pick an event for an all-attendees message.' });
    rows = db.prepare(
      `SELECT DISTINCT p.id AS person_id, p.first_name, p.last_name, p.nickname,
              e.id AS event_id, e.title
         FROM txn_person tp
         JOIN txn t ON t.id = tp.txn_id
         JOIN person p ON p.id = tp.person_id
         JOIN event e ON e.id = t.event_id
        WHERE t.event_id = ? AND t.direction = 'in' AND t.voided_by_txn_id IS NULL
          AND p.is_youth = 1 AND (? IS NULL OR p.patrol = ?)`
    ).all(b.event_id, patrol, patrol);
  } else {
    rows = onsiteYouthRows(patrol);
  }
  const r = await messageGuardians(rows, message);

  // Optional, additive, off by default: when the leader explicitly ticks
  // "include adults" on an ADULT-TRACKED event, opted-in adults who
  // attended (or are on site) are texted directly (their own consent —
  // person.sms_opt_in). The youth/guardian path above is untouched.
  let adults = { sent: [], skipped: [], sentCount: 0 };
  if (b.include_adults) {
    const { messageAdults } = require('../lib/notifySweep');
    let adultIds = [];
    if (b.scope === 'attended') {
      const ev = db.prepare('SELECT * FROM event WHERE id = ?').get(b.event_id);
      if (ev && ev.track_adults) {
        adultIds = db.prepare(
          `SELECT DISTINCT p.id FROM txn_person tp
             JOIN txn t ON t.id = tp.txn_id
             JOIN person p ON p.id = tp.person_id
            WHERE t.event_id = ? AND t.direction = 'in' AND t.voided_by_txn_id IS NULL
              AND p.is_youth = 0`
        ).all(b.event_id).map((x) => x.id);
      }
    } else {
      adultIds = db.prepare(
        `SELECT DISTINCT p.id FROM txn_person tp
           JOIN txn t ON t.id = tp.txn_id
           JOIN person p ON p.id = tp.person_id
           JOIN event e ON e.id = t.event_id
          WHERE tp.open = 1 AND t.voided_by_txn_id IS NULL
            AND p.is_youth = 0 AND e.track_adults = 1`
      ).all().map((x) => x.id);
    }
    adults = await messageAdults(adultIds, message);
  }

  res.json({
    scope: b.scope === 'attended' ? 'attended' : 'onsite', youth: rows.length,
    onsite_youth: rows.length, adults_included: b.include_adults ? 1 : 0,
    sent: [...r.sent, ...adults.sent], skipped: [...r.skipped, ...adults.skipped],
  });
});

router.get('/patrols', (req, res) => {
  res.json(db.prepare(
    `SELECT DISTINCT patrol FROM person
      WHERE is_youth = 1 AND status = 'active' AND patrol IS NOT NULL AND patrol != ''
      ORDER BY patrol`
  ).all().map((r) => r.patrol));
});

// -------------------------------------------------- roster import (admin) ----
router.post('/roster/import', auth.requireAuth('admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach the roster xlsx file.' });
  let people;
  try {
    people = roster.parseWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const mode = req.query.mode === 'commit' ? 'commit' : 'preview';
  if (mode === 'preview') {
    const p = roster.computePreview(people);
    return res.json({
      mode, total: people.length,
      youth: people.filter((x) => x.is_youth).length,
      adults: people.filter((x) => !x.is_youth).length,
      added: p.adds.map((x) => `${x.first_name} ${x.last_name}`),
      updated: p.updates.map((u) => ({ name: `${u.p.first_name} ${u.p.last_name}`, fields: Object.keys(u.ch) })),
      deactivated: p.deactivate.map((d) => `${d.first_name} ${d.last_name}`),
    });
  }
  const rawPath = path.join(UPLOAD_DIR, `${Date.now()}_${req.file.originalname}`);
  fs.writeFileSync(rawPath, req.file.buffer);
  const links = roster.suggestLinks(people);
  const result = roster.applyImport(people, links, req.staff.staff_id, req.file.originalname, rawPath);
  res.json({ mode, ...result });
});

module.exports = router;
