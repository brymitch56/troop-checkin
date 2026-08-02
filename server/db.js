'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'troop.db');
const SIG_DIR = path.join(DATA_DIR, 'signatures');
const UPLOAD_DIR = path.join(DATA_DIR, 'roster-uploads');

for (const d of [DATA_DIR, SIG_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// local_date(ts) -> 'YYYY-MM-DD' in the server's local timezone.
//
// Replaces SQLite's date(x, 'localtime') in the day-granular event
// past-rules. SQLite's 'localtime' asks the OS C runtime, which on Windows
// does NOT understand IANA `TZ` values (`TZ=America/New_York` in .env would
// be silently ignored in SQL while JavaScript honored it). Node's Date uses
// ICU and honors TZ identically on Linux, Windows, and in Docker — routing
// the conversion through JS makes SQL and JS agree on every platform, DST
// included. Accepts both stored timestamp shapes (ISO 'T'/'Z' and the
// SQLite space form, both UTC) plus 'now'.
function localDateOf(ts) {
  if (ts === null || ts === undefined) return null;
  let d;
  if (ts === 'now') d = new Date();
  else {
    const s = String(ts).trim();
    // space form ("2026-07-27 00:30:00") is stored UTC — mark it as such
    d = new Date(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  }
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
db.function('local_date', localDateOf);

module.exports = { db, DATA_DIR, DB_PATH, SIG_DIR, UPLOAD_DIR, localDateOf };
