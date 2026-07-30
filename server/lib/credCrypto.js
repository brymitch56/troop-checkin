'use strict';
// At-rest encryption for stored service credentials (currently the TLC
// password). AES-256-GCM with a key kept in .env (CRED_KEY) — deliberately
// OUTSIDE data/, so database snapshots and the nightly backups contain only
// ciphertext. A stolen backup no longer yields the password; only live
// access to BOTH the DB and .env does (and nothing software-side can defend
// against full live compromise of the box).
//
// The key is auto-generated on first save and appended to .env. If .env is
// missing or unwritable we throw rather than silently storing plaintext —
// the caller surfaces that to the admin.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const KEY_VAR = 'CRED_KEY';

function loadKey() {
  const hex = process.env[KEY_VAR];
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

// Generate a key if none exists, persist it to .env, and export it into
// process.env so the running process (and env.js live getters) see it.
function ensureKey(envPath = ENV_PATH) {
  const existing = loadKey();
  if (existing) return existing;
  if (process.env[KEY_VAR]) {
    throw new Error(`${KEY_VAR} in .env is malformed — it must be 64 hex characters.`);
  }
  const key = crypto.randomBytes(32);
  const line = `\n# Auto-generated key that encrypts stored service credentials (TLC password)\n` +
    `# at rest in the database. Keep this file out of backups and git (it is).\n` +
    `# Losing it means re-entering the credentials in Admin -> Import.\n` +
    `${KEY_VAR}=${key.toString('hex')}\n`;
  // append (never rewrite the file — no risk to existing config)
  fs.appendFileSync(envPath, line, { mode: 0o600 });
  process.env[KEY_VAR] = key.toString('hex');
  return key;
}

function encrypt(plaintext, key = loadKey()) {
  if (!key) throw new Error('No credential-encryption key available.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

// Returns the plaintext, or null when the key is missing/wrong or the
// ciphertext was tampered with (GCM authenticates) — callers treat null as
// "credentials unreadable" and fall back / surface it, never crash.
function decrypt(box, key = loadKey()) {
  try {
    if (!key || !box || box.v !== 1) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { loadKey, ensureKey, encrypt, decrypt, ENV_PATH, KEY_VAR };
