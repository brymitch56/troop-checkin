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
// Admin-entered credentials so nobody has to edit .env on the Pi. Stored in
// the meta table (same protection as everything else under data/: file perms
// + the encrypted off-site backup). They must be stored retrievable — TLC
// needs the real password at login — but they are WRITE-ONLY toward the
// browser: no API response ever includes the password. Resolution order for
// the fetcher: admin-saved (DB) wins over .env; .env remains the fallback so
// existing installs keep working untouched.
const CRED_KEY = 'tlc_credentials';

function getTlcCredentials() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(CRED_KEY);
  if (!row) return null;
  try {
    const c = JSON.parse(row.value);
    return c && c.email && c.password ? c : null;
  } catch { return null; }
}

function saveTlcCredentials({ email, password }) {
  const e = String(email || '').trim();
  if (!e) { const err = new Error('Email is required.'); err.code = 400; throw err; }
  const existing = getTlcCredentials();
  const p = String(password || '');
  if (!p && !existing) {
    const err = new Error('Password is required the first time.'); err.code = 400; throw err;
  }
  const value = JSON.stringify({
    email: e,
    password: p || existing.password, // blank password = keep the stored one
    updated_at: new Date().toISOString(),
  });
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(CRED_KEY, value);
  return { email: e, updated_at: JSON.parse(value).updated_at };
}

function clearTlcCredentials() {
  const r = db.prepare('DELETE FROM meta WHERE key = ?').run(CRED_KEY);
  return { cleared: r.changes > 0 };
}

// What the admin UI shows (never the password): where the effective
// credentials come from, and enough to recognize them.
function credentialInfo(env = process.env) {
  const saved = getTlcCredentials();
  if (saved) return { source: 'admin', email: saved.email, updated_at: saved.updated_at };
  if (env.TLC_EMAIL && env.TLC_PASSWORD) return { source: 'env', email: env.TLC_EMAIL, updated_at: null };
  return { source: null, email: null, updated_at: null };
}

module.exports = {
  stagePending, getPending, approvePending, discardPending,
  getTlcCredentials, saveTlcCredentials, clearTlcCredentials, credentialInfo,
};
