'use strict';
/**
 * On-site corrections across concurrent events (migration 019).
 *
 * Two events overlap (a campout with a meeting inside it; two units' meetings
 * at once). A youth gets signed into the wrong one because the kiosk had the
 * other event selected, or genuinely belongs in both. From the On-site screen
 * door staff can:
 *
 *   move   — re-file this person's OPEN sign-in under another current event.
 *            A new sign-in txn is written there with the original time,
 *            signer and signature, and the person's txn_person row moves onto
 *            it. Anyone else on the original group sign-in is untouched (a
 *            whole-txn void would have undone them too).
 *   copy   — add a LINKED second sign-in in another current event (same time,
 *            signer, signature). One sign-out later closes every linked
 *            sign-in and records attendance for each event (closeLinked).
 *   remove — undo a copy: leave one of the person's linked sign-ins, keeping
 *            the other(s). Never the last one — erasing attendance outright
 *            stays an admin void.
 *
 * Only OPEN sign-ins (still on site) are corrected here: attendance is
 * recorded at sign-out, so fixing the event before then fixes everything
 * downstream — the TLC/AHGFamily push, the badge tracker, reports.
 * Every correction is a txn_correction row (who, from, to, when).
 */
const { db } = require('../db');

class CorrectionError extends Error {
  constructor(status, msg, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); }
}
const fail = (status, msg, extra) => { throw new CorrectionError(status, msg, extra); };

// the kiosk's "current event" window (routes/api.js /events/current)
const WINDOW_BEFORE = '-30 minutes';
const WINDOW_AFTER = '+60 minutes';

const OPENS_SQL = `
  SELECT tp.txn_id AS in_txn_id, t.event_id, e.title AS event_title, e.start_at, e.end_at
    FROM txn_person tp
    JOIN txn t ON t.id = tp.txn_id
    JOIN event e ON e.id = t.event_id
   WHERE tp.person_id = ? AND tp.open = 1 AND t.voided_by_txn_id IS NULL
   ORDER BY datetime(e.start_at)`;
const opensOf = (personId) => db.prepare(OPENS_SQL).all(personId);

/**
 * The txn ids linked to `txnId` for this person: every sign-in reachable by
 * walking their move/copy corrections in either direction (a move keeps the
 * links of the sign-in it re-filed).
 */
function linkedTxnIds(personId, txnId) {
  const edges = db.prepare(
    `SELECT from_txn_id AS a, to_txn_id AS b FROM txn_correction
      WHERE person_id = ? AND kind IN ('move', 'copy') AND to_txn_id IS NOT NULL`
  ).all(personId);
  const seen = new Set([txnId]);
  const queue = [txnId];
  while (queue.length) {
    const cur = queue.shift();
    for (const { a, b } of edges) {
      const next = a === cur ? b : b === cur ? a : null;
      if (next != null && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

/** This person's OTHER open sign-ins linked to `inTxnId` (copies of it, or it of them). */
function linkedOpens(personId, inTxnId) {
  const ids = linkedTxnIds(personId, inTxnId);
  return opensOf(personId).filter((o) => o.in_txn_id !== inTxnId && ids.has(o.in_txn_id));
}

/** True when every open of this person belongs to one linked group. */
function opensAreOneGroup(personId, opens) {
  if (opens.length < 2) return true;
  const ids = linkedTxnIds(personId, opens[0].in_txn_id);
  return opens.every((o) => ids.has(o.in_txn_id));
}

/** What the On-site screen shows for a person: their opens, and where they could go. */
function optionsFor(personId) {
  const person = db.prepare('SELECT id, is_youth, first_name, last_name FROM person WHERE id = ?').get(personId);
  if (!person) fail(404, 'No such person.');
  const opens = opensOf(personId).map((o) => ({
    in_txn_id: o.in_txn_id, event_id: o.event_id, event_title: o.event_title,
    linked: linkedOpens(personId, o.in_txn_id).length > 0,
  }));
  const openEvents = new Set(opens.map((o) => o.event_id));
  const now = new Date().toISOString();
  const current = db.prepare(
    `SELECT id, title, start_at, end_at, track_adults FROM event
      WHERE datetime(start_at, ?) <= datetime(?) AND datetime(end_at, ?) >= datetime(?)
      ORDER BY datetime(start_at)`
  ).all(WINDOW_BEFORE, now, WINDOW_AFTER, now);
  const targets = current
    .filter((e) => !openEvents.has(e.id))
    .map((e) => ({ id: e.id, title: e.title, start_at: e.start_at, end_at: e.end_at,
      // an adult can only go where adults are tracked — say so up front
      allowed: !!person.is_youth || !!e.track_adults }));
  return { person_id: person.id, opens, targets };
}

// The open sign-in being corrected, and the event it should go to — checked
// exactly like a kiosk sign-in would be (adults, permission-form soft block).
function validate(personId, inTxnId, eventId, { forcePermission = false } = {}) {
  const person = db.prepare('SELECT * FROM person WHERE id = ?').get(personId);
  if (!person) fail(404, 'No such person.');
  const open = opensOf(personId).find((o) => o.in_txn_id === Number(inTxnId));
  if (!open) fail(409, `${person.first_name} is no longer signed in there — refresh the On-site list.`);
  const event = db.prepare('SELECT * FROM event WHERE id = ?').get(eventId);
  if (!event) fail(400, 'Pick the event to use.');
  if (event.id === open.event_id) fail(400, 'That is the event they are already signed into.');
  if (opensOf(personId).some((o) => o.event_id === event.id)) {
    fail(409, `${person.first_name} is already signed into ${event.title}.`);
  }
  if (!person.is_youth && !event.track_adults) {
    fail(422, `${event.title} does not track adult attendance.`);
  }
  if (person.is_youth && event.requires_permission_form && event.permission_block && !forcePermission) {
    const permSync = require('./permissionSync');
    if (permSync.getSettings().enabled && permSync.unsignedYouthIds(event.id, [person.id]).length) {
      fail(422, 'Permission form not signed.', {
        permission_unsigned: [`${person.first_name} ${person.last_name}`],
        fetched_at: permSync.lastFetchedAt(event.id),
      });
    }
  }
  const src = db.prepare('SELECT * FROM txn WHERE id = ?').get(open.in_txn_id);
  return { person, open, event, src };
}

// A sign-in in `event` carrying the original's time, signer and signature.
function writeSignInLike(src, event, staffId, tag, { forcePermission }) {
  const r = db.prepare(
    `INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id, signer_person_id,
                      signer_name_override, signature_path, forced, permission_override)
     VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?)`
  ).run(`${tag}-${src.id}-${event.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    event.id, src.signed_at, staffId, src.signer_person_id, src.signer_name_override,
    src.signature_path, src.forced, forcePermission ? 1 : src.permission_override || 0);
  return Number(r.lastInsertRowid);
}

const logCorrection = (kind, personId, from, to, staffId) => db.prepare(
  'INSERT INTO txn_correction (kind, person_id, from_txn_id, to_txn_id, staff_id) VALUES (?, ?, ?, ?, ?)'
).run(kind, personId, from, to, staffId);

/** Re-file an open sign-in under another current event. Returns the new txn id. */
function move(personId, inTxnId, eventId, staffId, opts = {}) {
  const { src, event } = validate(personId, inTxnId, eventId, opts);
  const newId = db.transaction(() => {
    const id = writeSignInLike(src, event, staffId, 'move', opts);
    db.prepare('UPDATE txn_person SET txn_id = ? WHERE txn_id = ? AND person_id = ?').run(id, src.id, personId);
    logCorrection('move', personId, src.id, id, staffId);
    return id;
  })();
  return { txn_id: newId, event_id: event.id, event_title: event.title };
}

/** Add a linked second sign-in in another current event. Returns the new txn id. */
function copy(personId, inTxnId, eventId, staffId, opts = {}) {
  const { src, event } = validate(personId, inTxnId, eventId, opts);
  const row = db.prepare('SELECT * FROM txn_person WHERE txn_id = ? AND person_id = ?').get(src.id, personId);
  const newId = db.transaction(() => {
    const id = writeSignInLike(src, event, staffId, 'copy', opts);
    db.prepare(
      `INSERT INTO txn_person (txn_id, person_id, open, in_txn_id, emerg_phone_1, emerg_phone_2)
       VALUES (?, ?, 1, NULL, ?, ?)`
    ).run(id, personId, row.emerg_phone_1, row.emerg_phone_2);
    logCorrection('copy', personId, src.id, id, staffId);
    return id;
  })();
  return { txn_id: newId, event_id: event.id, event_title: event.title };
}

/**
 * Leave one linked sign-in, keeping the other(s). A sign-in that holds only
 * this person is voided (the existing append-only correction); on a group
 * sign-in only this person's row is taken off it. Returns { voided_txn_id? }.
 */
function remove(personId, inTxnId, staffId) {
  const person = db.prepare('SELECT * FROM person WHERE id = ?').get(personId);
  if (!person) fail(404, 'No such person.');
  const id = Number(inTxnId);
  const open = opensOf(personId).find((o) => o.in_txn_id === id);
  if (!open) fail(409, `${person.first_name} is no longer signed in there — refresh the On-site list.`);
  const keep = linkedOpens(personId, id);
  if (!keep.length) {
    fail(409, `${open.event_title} is ${person.first_name}'s only sign-in — move it instead, or sign them out.`);
  }
  const t = db.prepare('SELECT * FROM txn WHERE id = ?').get(id);
  const others = db.prepare('SELECT COUNT(*) c FROM txn_person WHERE txn_id = ? AND person_id != ?').get(id, personId).c;
  return db.transaction(() => {
    if (!others) {
      const v = db.prepare(
        `INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id, close_method)
         VALUES (?, ?, 'in', ?, ?, 'admin_close')`
      ).run(`remove-${id}-${Date.now()}`, t.event_id, new Date().toISOString(), staffId);
      const vid = Number(v.lastInsertRowid);
      db.prepare('INSERT INTO txn_person (txn_id, person_id, open, in_txn_id) VALUES (?, ?, 0, ?)').run(vid, personId, id);
      db.prepare('UPDATE txn_person SET open = 0 WHERE txn_id = ? AND person_id = ?').run(id, personId);
      db.prepare('UPDATE txn SET voided_by_txn_id = ? WHERE id = ?').run(vid, id);
      logCorrection('remove', personId, id, keep[0].in_txn_id, staffId);
      return { voided_txn_id: id, void_txn_id: vid };
    }
    db.prepare('DELETE FROM txn_person WHERE txn_id = ? AND person_id = ?').run(id, personId);
    logCorrection('remove', personId, id, keep[0].in_txn_id, staffId);
    return {};
  })();
}

/**
 * Sign-out companion: close the person's OTHER linked open sign-ins the same
 * way the chosen one was closed (same time, signer, signature, method), one
 * sign-out txn per event. Call inside the caller's transaction. Returns
 * [{ event_id, txn_id, person_id }] so the caller can enqueue attendance and
 * emit webhooks after commit.
 */
function closeLinked(personId, chosenInTxnId, out) {
  const closed = [];
  for (const o of linkedOpens(personId, chosenInTxnId)) {
    const r = db.prepare(
      `INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id, signer_person_id,
                        signer_name_override, signature_path, close_method, forced)
       VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?)`
    ).run(`${out.client_uuid || 'out'}-linked-${o.in_txn_id}-${personId}`, o.event_id, out.signed_at, out.staff_id,
      out.signer_person_id || null, out.signer_name_override || null, out.signature_path || null,
      out.close_method || null, out.forced ? 1 : 0);
    const txnId = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO txn_person (txn_id, person_id, open, in_txn_id) VALUES (?, ?, 0, ?)')
      .run(txnId, personId, o.in_txn_id);
    db.prepare('UPDATE txn_person SET open = 0 WHERE txn_id = ? AND person_id = ?').run(o.in_txn_id, personId);
    closed.push({ event_id: o.event_id, txn_id: txnId, person_id: personId });
  }
  return closed;
}

module.exports = {
  CorrectionError, optionsFor, move, copy, remove, closeLinked, linkedOpens, opensAreOneGroup, linkedTxnIds,
};
