'use strict';
// Nightly backup (Phase 2): consistent DB snapshot via VACUUM INTO plus a tar
// of signature PNGs, written under $DATA_DIR/backups/. Off-device push is a
// manual rclone step — see README ("Backups"). Keeps the newest 14.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { db, DATA_DIR, SIG_DIR } = require('../db');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 14;

function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const dbOut = path.join(BACKUP_DIR, `troop-${stamp}.db`);
  const sigOut = path.join(BACKUP_DIR, `signatures-${stamp}.tar.gz`);

  db.prepare('VACUUM INTO ?').run(dbOut); // consistent snapshot, WAL-safe

  const sigs = fs.existsSync(SIG_DIR) ? fs.readdirSync(SIG_DIR) : [];
  if (sigs.length) {
    execFileSync('tar', ['-czf', sigOut, '-C', SIG_DIR, '.'], { stdio: 'ignore' });
  }

  prune();
  return { db: dbOut, signatures: sigs.length ? sigOut : null, signature_count: sigs.length };
}

function prune() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('troop-') && f.endsWith('.db'))
    .sort().reverse();
  for (const f of files.slice(KEEP)) {
    const stamp = f.slice('troop-'.length, -'.db'.length);
    fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
    fs.rmSync(path.join(BACKUP_DIR, `signatures-${stamp}.tar.gz`), { force: true });
  }
}

function scheduleNightly() {
  // fire at ~03:15 local time, then every 24h
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 15, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    const tick = () => {
      try { runBackup(); } catch (e) { console.error('backup failed:', e.message); }
    };
    tick();
    setInterval(tick, 24 * 60 * 60 * 1000).unref();
  }, next - now).unref();
}

module.exports = { runBackup, scheduleNightly, BACKUP_DIR };

if (require.main === module) {
  const r = runBackup();
  console.log(`backup written:\n  ${r.db}\n  ${r.signatures || '(no signatures yet)'}`);
}
