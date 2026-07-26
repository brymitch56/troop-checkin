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

module.exports = { stagePending, getPending, approvePending, discardPending };
