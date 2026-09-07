'use strict';
// Outbound webhook for the Integration API (docs/13-integration-api.md).
//
// When enabled, the app POSTs a signed JSON payload to ONE configured URL
// after a transaction is committed (kiosk sign-in/out, admin close, SMS
// pickup confirm), after a void, and after an iCal sync. Design rules:
//   - fires AFTER the SQLite commit, from the same request, via a queue
//     table + background sweep — the sign-in path is never blocked or failed
//     by a slow/unreachable consumer (enqueue is one local INSERT wrapped in
//     try/catch by every caller)
//   - late-replayed offline txns fire like any other, with their original
//     signed_at — the consumer keys idempotency on txn.id
//   - payloads carry identifiers only: no names, no contact data
//   - the shared secret is AES-GCM-encrypted at rest (lib/credCrypto, same
//     key as the TLC password) and never displayed after saving
//   - off by default; nothing is queued while disabled
const crypto = require('crypto');
const { db } = require('../db');
const env = require('./env');
const credCrypto = require('./credCrypto');

const SETTINGS_KEY = 'integration_webhook';
const ALL_EVENTS = ['txn.created', 'txn.voided', 'ical.synced'];
// retry delays by attempt number (seconds): 1m, 5m, 30m, then 2h steps —
// 14 attempts ≈ 23.6h before a delivery is marked failed (Retry failed
// in the admin UI starts the ladder over)
const BACKOFF_S = [60, 300, 1800, 7200];
const MAX_ATTEMPTS = 14;
const TIMEOUT_MS = 10_000;
const SIGNATURE_TOLERANCE_S = 300; // documented for consumers: reject older timestamps

function readMeta(key, fallback) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return { ...fallback };
  try { return { ...fallback, ...JSON.parse(row.value) }; } catch { return { ...fallback }; }
}
function writeMeta(key, obj) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(obj));
}

// ----------------------------------------------------------- settings ------
const DEFAULTS = { enabled: 0, url: '', secret: null, events: [...ALL_EVENTS] };
const getSettings = () => readMeta(SETTINGS_KEY, DEFAULTS);

// Admin-facing view — secret shown only as set / not set.
function status() {
  const s = getSettings();
  return { enabled: s.enabled ? 1 : 0, url: s.url || '', secret_set: !!s.secret, events: s.events || [] };
}

function validUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}

// patch: {enabled?, url?, secret?, clear_secret?, events?}. An empty secret
// string keeps the stored one (the field is write-only in the UI).
function saveSettings(patch = {}) {
  const s = getSettings();
  if ('url' in patch) {
    const url = String(patch.url || '').trim();
    if (url && !validUrl(url)) throw Object.assign(new Error('Webhook URL must be http(s)://…'), { code: 400 });
    s.url = url;
  }
  if ('events' in patch) {
    const ev = Array.isArray(patch.events) ? patch.events.filter((e) => ALL_EVENTS.includes(e)) : [];
    s.events = ev;
  }
  if (patch.clear_secret) s.secret = null;
  else if (typeof patch.secret === 'string' && patch.secret.trim()) {
    const key = credCrypto.ensureKey(); // throws if .env is unwritable — surfaced to the admin
    s.secret = credCrypto.encrypt(patch.secret.trim(), key);
  }
  if ('enabled' in patch) {
    const on = patch.enabled ? 1 : 0;
    if (on && !s.url) throw Object.assign(new Error('Set the webhook URL before enabling.'), { code: 422 });
    if (on && !s.secret) throw Object.assign(new Error('Set a signing secret before enabling.'), { code: 422 });
    s.enabled = on;
  }
  writeMeta(SETTINGS_KEY, s);
  return status();
}

function secretPlain(s = getSettings()) {
  return s.secret ? credCrypto.decrypt(s.secret) : null; // null when the key is missing/rotated
}

// ---------------------------------------------------------- signature ------
// X-Troop-Checkin-Signature: sha256=HMAC-SHA256(secret, `${timestamp}.${body}`)
function sign(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${body}`).digest('hex');
}
// Reference verifier (what consumers should implement; used by the tests).
function verifySignature(secret, timestamp, body, signature, now = Math.floor(Date.now() / 1000)) {
  if (!/^\d+$/.test(String(timestamp))) return false;
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const got = Buffer.from(String(signature || ''));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// ------------------------------------------------------------- payloads ----
const instance = () => ({ troop_id: env.TROOP_ID, theme: env.THEME });

function resolvePerson(id) {
  let p = db.prepare('SELECT id, member_id, tlc_user_id, is_youth, status, merged_into_id FROM person WHERE id = ?').get(id);
  for (let i = 0; p && p.status === 'merged' && p.merged_into_id && i < 8; i++) {
    p = db.prepare('SELECT id, member_id, tlc_user_id, is_youth, status, merged_into_id FROM person WHERE id = ?').get(p.merged_into_id);
  }
  return p;
}

function txnPayload(txnId) {
  const t = db.prepare(
    `SELECT t.id, t.client_uuid, t.event_id, t.direction, t.signed_at, t.forced, t.voided_by_txn_id,
            e.ical_uid, e.start_at
       FROM txn t JOIN event e ON e.id = t.event_id WHERE t.id = ?`).get(txnId);
  if (!t) return null;
  const persons = db.prepare('SELECT person_id FROM txn_person WHERE txn_id = ? ORDER BY person_id').all(txnId)
    .map((r) => resolvePerson(r.person_id)).filter(Boolean)
    .map((p) => ({ person_id: p.id, member_id: p.member_id, tlc_user_id: p.tlc_user_id, is_youth: p.is_youth ? 1 : 0 }));
  return {
    txn: {
      id: t.id, client_uuid: t.client_uuid, event_id: t.event_id, ical_uid: t.ical_uid, start_at: t.start_at,
      direction: t.direction, signed_at: t.signed_at, forced: t.forced ? 1 : 0, voided_by_txn_id: t.voided_by_txn_id,
    },
    persons,
  };
}

// ---------------------------------------------------------------- queue ----
// Never throws past its caller's try/catch: one INSERT, then a nudge to the
// sweep so a healthy consumer sees the event within a second, not a minute.
function enqueue(type, body, { force = false } = {}) {
  const s = getSettings();
  if (!s.url) return null;
  if (!force && (!s.enabled || !(s.events || []).includes(type))) return null;
  const payload = JSON.stringify({ type, sent_at: new Date().toISOString(), instance: instance(), ...body });
  const id = Number(db.prepare(`INSERT INTO webhook_delivery (type, payload) VALUES (?, ?)`).run(type, payload).lastInsertRowid);
  nudge();
  return id;
}

// The three app hooks. Each is wrapped so a consumer-side problem (bad URL,
// missing key) can never surface into a kiosk or admin response.
function emitTxnCreated(txnId) {
  try {
    const p = txnPayload(txnId);
    return p ? enqueue('txn.created', p) : null;
  } catch (e) { console.error('[webhook] txn.created failed:', e.message); return null; }
}
function emitTxnVoided(voidedTxnId, voidingTxnId) {
  try {
    const p = txnPayload(voidedTxnId);
    if (!p) return null;
    p.txn.voided_by_txn_id = voidingTxnId;
    return enqueue('txn.voided', { ...p, voided_txn_id: voidedTxnId, voiding_txn_id: voidingTxnId });
  } catch (e) { console.error('[webhook] txn.voided failed:', e.message); return null; }
}
function emitIcalSynced(result) {
  try {
    const { added = 0, updated = 0, flagged = 0, deleted = 0, feed_events = 0 } = result || {};
    return enqueue('ical.synced', { counts: { added, updated, flagged, deleted, feed_events } });
  } catch (e) { console.error('[webhook] ical.synced failed:', e.message); return null; }
}

// ------------------------------------------------------------- delivery ----
// Pluggable transport so tests can run without a socket; default is fetch.
let transport = async (url, opts) => fetch(url, opts);
const setTransport = (fn) => { transport = fn || ((url, opts) => fetch(url, opts)); };

async function deliverRow(row, s = getSettings()) {
  const secret = secretPlain(s);
  if (!s.url) throw new Error('No webhook URL configured.');
  if (!secret) throw new Error('Signing secret unreadable — re-enter it in Admin → Integrations.');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await transport(s.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Troop-Checkin-Event': row.type,
      'X-Troop-Checkin-Timestamp': timestamp,
      'X-Troop-Checkin-Signature': sign(secret, timestamp, row.payload),
      'User-Agent': 'troop-checkin-webhook',
    },
    body: row.payload,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res ? res.status : 'no response'}`);
  }
  return res.status;
}

// prepared lazily — this module may be required before migrations run
const markSent = { run: (id) => db.prepare(
  `UPDATE webhook_delivery SET status = 'sent', attempts = attempts + 1, last_error = NULL,
          sent_at = datetime('now') WHERE id = ?`).run(id) };
function markFailedAttempt(row, err) {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(`UPDATE webhook_delivery SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`)
      .run(attempts, err, row.id);
    return;
  }
  const delay = BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)];
  db.prepare(`UPDATE webhook_delivery SET attempts = ?, last_error = ?,
                     next_attempt_at = datetime('now', ?) WHERE id = ?`)
    .run(attempts, err, `+${delay} seconds`, row.id);
}

let running = false;
const isRunning = () => running;

// Single-flight: deliver everything due, oldest first. A disabled webhook
// still drains what was queued while it was on? No — it stops; rows wait
// (and keep their backoff) until re-enabled or retried by hand.
async function sweep({ limit = 50 } = {}) {
  if (running) return { skipped: true, reason: 'running' };
  const s = getSettings();
  if (!s.enabled || !s.url) return { skipped: true, reason: 'disabled' };
  const due = db.prepare(
    `SELECT * FROM webhook_delivery WHERE status = 'pending' AND next_attempt_at <= datetime('now')
      ORDER BY id LIMIT ?`).all(limit);
  if (!due.length) return { sent: 0, failed: 0 };
  running = true;
  const out = { sent: 0, failed: 0 };
  try {
    for (const row of due) {
      try { await deliverRow(row, s); markSent.run(row.id); out.sent++; }
      catch (e) { markFailedAttempt(row, String(e.message || e).slice(0, 300)); out.failed++; }
    }
  } finally { running = false; }
  return out;
}

// Called by enqueue: run a sweep on the next tick (unref'd; harmless if a
// sweep is already running — the interval catches anything left).
let nudged = false;
function nudge() {
  if (nudged) return;
  nudged = true;
  const t = setTimeout(() => {
    nudged = false;
    sweep().catch((e) => console.error('[webhook] sweep failed:', e.message));
  }, 50);
  t.unref();
}

// "Send test event": delivered synchronously so the admin sees the result.
async function sendTest() {
  const s = getSettings();
  if (!s.url) throw Object.assign(new Error('Set the webhook URL first.'), { code: 422 });
  if (!s.secret) throw Object.assign(new Error('Set a signing secret first.'), { code: 422 });
  const payload = JSON.stringify({ type: 'test', sent_at: new Date().toISOString(), instance: instance() });
  const id = Number(db.prepare(`INSERT INTO webhook_delivery (type, payload) VALUES ('test', ?)`).run(payload).lastInsertRowid);
  const row = db.prepare('SELECT * FROM webhook_delivery WHERE id = ?').get(id);
  try {
    const code = await deliverRow(row, s);
    markSent.run(id);
    return { ok: true, id, http: code };
  } catch (e) {
    // a test never retries — one shot, mark it failed so the log shows it
    db.prepare(`UPDATE webhook_delivery SET status = 'failed', attempts = 1, last_error = ? WHERE id = ?`)
      .run(String(e.message || e).slice(0, 300), id);
    return { ok: false, id, error: String(e.message || e) };
  }
}

function retryFailed() {
  const r = db.prepare(
    `UPDATE webhook_delivery SET status = 'pending', attempts = 0, last_error = NULL,
            next_attempt_at = datetime('now') WHERE status = 'failed' AND type != 'test'`).run();
  if (r.changes) nudge();
  return { retried: r.changes };
}

function recentRows(limit = 30) {
  return db.prepare(
    `SELECT id, type, status, attempts, last_error, next_attempt_at, created_at, sent_at, length(payload) AS bytes
       FROM webhook_delivery ORDER BY id DESC LIMIT ?`).all(limit);
}
function queueSummary() {
  const r = { pending: 0, sent: 0, failed: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) n FROM webhook_delivery GROUP BY status').all()) r[row.status] = row.n;
  return r;
}
function lastDelivery() {
  return db.prepare(`SELECT id, type, sent_at FROM webhook_delivery WHERE status = 'sent' ORDER BY sent_at DESC, id DESC LIMIT 1`).get() || null;
}

// Retention: sent rows older than TLC_RETAIN_DAYS (default 30) go away;
// pending/failed rows are kept until they resolve or are retried.
function prune(days = Number(process.env.TLC_RETAIN_DAYS) > 0 ? Number(process.env.TLC_RETAIN_DAYS) : 30) {
  return db.prepare(`DELETE FROM webhook_delivery WHERE status = 'sent' AND datetime(sent_at) < datetime('now', ?)`)
    .run(`-${days} days`).changes;
}

// Every minute: deliver what is due; prune once an hour. All guards live in
// sweep (disabled → nothing), so the timer is dumb and unref'd.
function scheduleSweep(intervalMs = 60 * 1000) {
  let ticks = 0;
  const t = setInterval(() => {
    sweep().catch((e) => console.error('[webhook] sweep failed:', e.message));
    if (++ticks % 60 === 0) { try { prune(); } catch (e) { console.error('[webhook] prune failed:', e.message); } }
  }, intervalMs);
  t.unref();
  return t;
}

module.exports = {
  ALL_EVENTS, SETTINGS_KEY, BACKOFF_S, MAX_ATTEMPTS, SIGNATURE_TOLERANCE_S,
  getSettings, status, saveSettings, secretPlain,
  sign, verifySignature, txnPayload,
  enqueue, emitTxnCreated, emitTxnVoided, emitIcalSynced,
  deliverRow, sweep, sendTest, retryFailed, recentRows, queueSummary, lastDelivery, prune,
  scheduleSweep, isRunning, setTransport,
};
