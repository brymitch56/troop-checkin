'use strict';
// Integration API key (docs/13-integration-api.md).
//
// One key per instance, for server-to-server consumers (a reporting
// dashboard, a second troop tool on the same box). Off by default: while
// `enabled` is 0 — or no key has been generated — every /api/integration/*
// request answers 401, so existing installs see no behavior change.
//
// The plaintext key is shown exactly once at generation and only its scrypt
// hash is stored (same primitive as staff PIN/password hashes). Verification
// is constant-time (auth.verifySecret → crypto.timingSafeEqual). Failed
// attempts are counted (no key material) for the admin status block.
const crypto = require('crypto');
const { db } = require('../db');
const auth = require('../auth');

const SETTINGS_KEY = 'integration_api';
const KEY_PREFIX = 'tci_'; // makes a leaked key recognizable in scanners/logs

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

const DEFAULTS = {
  enabled: 0, key_hash: null, key_hint: null, created_at: null, label: null,
  failed_count: 0, failed_last_at: null, last_ok_at: null,
};
const getSettings = () => readMeta(SETTINGS_KEY, DEFAULTS);

// Admin-facing view: never includes the hash.
function status() {
  const s = getSettings();
  return {
    enabled: s.enabled ? 1 : 0,
    key_set: !!s.key_hash,
    key_hint: s.key_hint,          // first 8 chars — enough to tell keys apart, useless alone
    created_at: s.created_at,
    label: s.label,
    failed_count: s.failed_count || 0,
    failed_last_at: s.failed_last_at,
    last_ok_at: s.last_ok_at,
  };
}

function setEnabled(on) {
  const s = getSettings();
  s.enabled = on ? 1 : 0;
  writeMeta(SETTINGS_KEY, s);
  return status();
}

// Generates a fresh 256-bit key, stores only its hash, returns the plaintext
// ONCE. Regenerating replaces the old key (the old one stops working
// immediately). Failure counters reset with a new key.
function generateKey(label) {
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const s = getSettings();
  s.key_hash = auth.hashSecret(key);
  s.key_hint = key.slice(0, 8);
  s.created_at = new Date().toISOString();
  s.label = label ? String(label).slice(0, 60) : null;
  s.failed_count = 0; s.failed_last_at = null; s.last_ok_at = null;
  writeMeta(SETTINGS_KEY, s);
  return { key, ...status() };
}

function revokeKey() {
  const s = getSettings();
  s.key_hash = null; s.key_hint = null; s.created_at = null; s.label = null;
  writeMeta(SETTINGS_KEY, s);
  return status();
}

// Pure check — used by the middleware and directly by tests.
function verifyKey(presented, settings = getSettings()) {
  if (!settings.enabled || !settings.key_hash) return false;
  if (typeof presented !== 'string' || !presented) return false;
  return auth.verifySecret(presented, settings.key_hash);
}

function bearerOf(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

function recordFailure() {
  const s = getSettings();
  s.failed_count = (s.failed_count || 0) + 1;
  s.failed_last_at = new Date().toISOString();
  writeMeta(SETTINGS_KEY, s);
}

// Success timestamps are written at most once a minute — a polling consumer
// must not turn every request into a meta write.
let lastOkWrite = 0;
function recordSuccess() {
  const now = Date.now();
  if (now - lastOkWrite < 60_000) return;
  lastOkWrite = now;
  const s = getSettings();
  s.last_ok_at = new Date(now).toISOString();
  writeMeta(SETTINGS_KEY, s);
}

// Express middleware. Bearer only — no cookie fallback here, and the key is
// accepted on no other route. The 401 body is identical for "disabled",
// "no key", "missing header" and "wrong key" (no oracle).
function requireApiKey(req, res, next) {
  const settings = getSettings();
  const presented = bearerOf(req);
  if (!verifyKey(presented, settings)) {
    // only count attempts that actually presented something while the API is
    // live — an unconfigured instance being probed is noise, not a signal
    if (settings.enabled && settings.key_hash && presented) recordFailure();
    return res.status(401).json({ error: 'invalid api key' });
  }
  recordSuccess();
  next();
}

module.exports = {
  getSettings, status, setEnabled, generateKey, revokeKey, verifyKey, requireApiKey,
  KEY_PREFIX, SETTINGS_KEY,
};
