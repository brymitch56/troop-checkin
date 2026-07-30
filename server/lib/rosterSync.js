'use strict';
// Pending-import staging for the automated roster sync. The fetch job calls
// stagePending() after a successful download; the admin UI approves or
// discards. The preview is computed through the SAME functions as the manual
// import route (parseWorkbook/computePreview), so the two paths can never
// disagree about what an import would do. Approval re-runs the full
// parse+apply at click time — the stored preview is display-only.
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const roster = require('./rosterImport');

// Parse the file, compute the diff, and store it as THE pending import
// (replacing any previous one — only one can exist at a time).
function stagePending(filePath, buf, source = 'sync') {
  const people = roster.parseWorkbook(buf);
  const p = roster.computePreview(people);
  const preview = {
    total: people.length,
    youth: people.filter((x) => x.is_youth).length,
    adults: people.filter((x) => !x.is_youth).length,
    added: p.adds.map((x) => `${x.first_name} ${x.last_name}`),
    updated: p.updates.map((u) => ({ name: `${u.p.first_name} ${u.p.last_name}`, fields: Object.keys(u.ch) })),
    deactivated: p.deactivate.map((d) => `${d.first_name} ${d.last_name}`),
  };
  const run = db.transaction(() => {
    const replaced = db.prepare('SELECT COUNT(*) c FROM pending_import').get().c;
    db.prepare('DELETE FROM pending_import').run();
    const r = db.prepare(
      `INSERT INTO pending_import (file_path, rows, source, preview_json, replaced_count)
       VALUES (?, ?, ?, ?, ?)`
    ).run(filePath, people.length, source, JSON.stringify(preview), replaced);
    return { pending_id: Number(r.lastInsertRowid), replaced };
  });
  return run();
}

function getPending() {
  const row = db.prepare('SELECT * FROM pending_import ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  let preview = {};
  try { preview = JSON.parse(row.preview_json); } catch { /* display-only */ }
  return {
    id: row.id, fetched_at: row.fetched_at, rows: row.rows,
    source: row.source, replaced_count: row.replaced_count, preview,
  };
}

// One-tap approval: re-parse the stored file and run the normal apply path
// (guardian suggestions, field locks, deactivation scoping, import logging —
// identical to a manual upload). Attributed to the approving admin.
function approvePending(staffId) {
  const row = db.prepare('SELECT * FROM pending_import ORDER BY id DESC LIMIT 1').get();
  if (!row) { const e = new Error('No pending import to approve.'); e.code = 404; throw e; }
  let buf;
  try { buf = fs.readFileSync(row.file_path); }
  catch { const e = new Error('The fetched file is no longer on disk — run a new sync.'); e.code = 410; throw e; }
  const people = roster.parseWorkbook(buf);
  const links = roster.suggestLinks(people);
  const result = roster.applyImport(people, links, staffId, path.basename(row.file_path), row.file_path);
  db.prepare('DELETE FROM pending_import WHERE id = ?').run(row.id);
  return result;
}

function discardPending() {
  const r = db.prepare('DELETE FROM pending_import').run();
  return { discarded: r.changes };
}

// ------------------------------------------------------- TLC credentials ---
// Admin-entered credentials so nobody has to edit .env on the Pi. The
// password must be stored retrievable — TLC needs the real value at login —
// so it is ENCRYPTED AT REST (AES-256-GCM via lib/credCrypto) with a key
// kept in .env, outside data/: database snapshots and nightly backups hold
// only ciphertext. WRITE-ONLY toward the browser: no API response ever
// includes the password. Resolution order for the fetcher: admin-saved (DB)
// wins over .env; .env remains the fallback. Legacy plaintext rows (saved
// before encryption existed) are read once and transparently re-encrypted.
const credCrypto = require('./credCrypto');
const CRED_KEY = 'tlc_credentials';

function readCredRow() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(CRED_KEY);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function writeCredRow(email, password, { encrypt = true } = {}) {
  const updated_at = new Date().toISOString();
  let value;
  if (encrypt) {
    credCrypto.ensureKey();
    value = { email, password_enc: credCrypto.encrypt(password), updated_at, enc: 1 };
  } else {
    value = { email, password, updated_at };
  }
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(CRED_KEY, JSON.stringify(value));
  return updated_at;
}

function getTlcCredentials() {
  const c = readCredRow();
  if (!c || !c.email) return null;
  if (c.enc === 1 && c.password_enc) {
    const password = credCrypto.decrypt(c.password_enc);
    if (password == null) {
      console.error('[rosterSync] Stored TLC credentials cannot be decrypted — CRED_KEY missing or changed in .env. Re-enter them in Admin → Import.');
      return null;
    }
    return { email: c.email, password, updated_at: c.updated_at };
  }
  if (c.password) {
    // legacy plaintext row: migrate to encrypted transparently when possible
    try { writeCredRow(c.email, c.password); } catch { /* no writable .env — keep working */ }
    return { email: c.email, password: c.password, updated_at: c.updated_at };
  }
  return null;
}

function saveTlcCredentials({ email, password }) {
  const e = String(email || '').trim();
  if (!e) { const err = new Error('Email is required.'); err.code = 400; throw err; }
  const existing = getTlcCredentials();
  const p = String(password || '');
  if (!p && !existing) {
    const err = new Error('Password is required the first time.'); err.code = 400; throw err;
  }
  let updated_at;
  try {
    updated_at = writeCredRow(e, p || existing.password); // blank password = keep stored one
  } catch (err) {
    const e2 = new Error(`Could not set up credential encryption (${err.message}) — nothing was saved.`);
    e2.code = 500; throw e2;
  }
  return { email: e, updated_at };
}

function clearTlcCredentials() {
  const r = db.prepare('DELETE FROM meta WHERE key = ?').run(CRED_KEY);
  return { cleared: r.changes > 0 };
}

// What the admin UI shows (never the password): where the effective
// credentials come from, whether they're encrypted at rest, and whether
// they're currently readable (a changed/lost CRED_KEY shows up here loudly
// instead of as a mystery fetch failure).
function credentialInfo(env = process.env) {
  const raw = readCredRow();
  if (raw && raw.email) {
    const encrypted = raw.enc === 1;
    const readable = encrypted ? credCrypto.decrypt(raw.password_enc) != null : !!raw.password;
    return { source: 'admin', email: raw.email, updated_at: raw.updated_at, encrypted, readable };
  }
  if (env.TLC_EMAIL && env.TLC_PASSWORD) {
    return { source: 'env', email: env.TLC_EMAIL, updated_at: null, encrypted: false, readable: true };
  }
  return { source: null, email: null, updated_at: null, encrypted: false, readable: false };
}

module.exports = {
  stagePending, getPending, approvePending, discardPending,
  getTlcCredentials, saveTlcCredentials, clearTlcCredentials, credentialInfo,
};
