'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

const MIG_DIR = path.join(__dirname, 'migrations');

db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const applied = new Set(
  db.prepare('SELECT name FROM schema_migration').all().map((r) => r.name)
);
const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

let ran = 0;
for (const f of files) {
  if (applied.has(f)) continue;
  const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
  const apply = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migration (name) VALUES (?)').run(f);
  });
  apply();
  console.log(`applied ${f}`);
  ran++;
}
console.log(ran ? `${ran} migration(s) applied.` : 'database is up to date.');
