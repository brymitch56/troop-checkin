'use strict';
// Guardian text replies, surfaced to door staff.
//
// Inbound non-keyword texts ("running 10 min late", "can he ride home
// with a friend?") are logged in sms_message by routes/sms.js. On their own they
// were visible only in Admin -> Messages, so a reply at pickup went unseen.
// Kiosks poll unread() and show a banner; markSeen() clears it for every
// station at once (migration 018).
//
// meta key 'sms_reply_alerts' — {enabled: bool}. Default ON (decided
// 2026-09-27): a missed parent reply at the door is the failure this exists
// to prevent, and the banner only shows what the leaders already receive.
const { db } = require('../db');

const KEY = 'sms_reply_alerts';
// Kiosks only show recent replies; anything older is history for the
// Messages tab, not something to act on at the door.
const WINDOW_HOURS = 48;

function getSettings() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
  try { return { enabled: row ? JSON.parse(row.value).enabled !== false : true }; }
  catch { return { enabled: true }; }
}
function saveSettings(patch) {
  const v = { enabled: !!(patch && patch.enabled) };
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(KEY, JSON.stringify(v));
  return v;
}

// Unseen replies, newest first, with the youth each sender is linked to so
// door staff can tell which family wrote without knowing parents by name.
function unread({ now = new Date() } = {}) {
  if (!getSettings().enabled) return [];
  const since = new Date(now.getTime() - WINDOW_HOURS * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19); // sms_message.at is SQLite datetime()
  const rows = db.prepare(
    `SELECT m.id, m.at, m.body, m.phone, m.guardian_id,
            g.first_name || ' ' || g.last_name AS guardian_name
       FROM sms_message m LEFT JOIN person g ON g.id = m.guardian_id
      WHERE m.direction = 'in' AND m.kind = 'reply' AND m.seen_at IS NULL
        AND m.at >= ?
      ORDER BY m.id DESC LIMIT 50`).all(since);
  const youthOf = db.prepare(
    `SELECT COALESCE(y.nickname, y.first_name) || ' ' || y.last_name AS name
       FROM person_guardian pg JOIN person y ON y.id = pg.youth_id
      WHERE pg.guardian_id = ? AND y.status IN ('active', 'visitor')
      ORDER BY y.last_name, y.first_name`);
  return rows.map((r) => ({
    ...r,
    youth: r.guardian_id ? youthOf.all(r.guardian_id).map((y) => y.name) : [],
  }));
}

// Mark replies seen. Only unseen inbound rows are touched, so a second
// station tapping "Got it" a moment later changes nothing.
function markSeen(ids, staffId = null) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!list.length) return 0;
  const upd = db.prepare(
    `UPDATE sms_message SET seen_at = datetime('now'), seen_by = ?
      WHERE id = ? AND direction = 'in' AND seen_at IS NULL`);
  let n = 0;
  db.transaction(() => { for (const id of list) n += upd.run(staffId, id).changes; })();
  return n;
}
function markAllSeen(staffId = null) {
  return db.prepare(
    `UPDATE sms_message SET seen_at = datetime('now'), seen_by = ?
      WHERE direction = 'in' AND seen_at IS NULL`).run(staffId).changes;
}

module.exports = { getSettings, saveSettings, unread, markSeen, markAllSeen, WINDOW_HOURS };
