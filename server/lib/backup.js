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

  // Signature tarball via the system `tar` (present on Linux, macOS, Docker
  // slim images, and Windows 10+). If tar is missing or fails, keep the DB
  // snapshot — the primary artifact — and warn instead of failing the backup.
  const sigs = fs.existsSync(SIG_DIR) ? fs.readdirSync(SIG_DIR) : [];
  let sigOk = false;
  if (sigs.length) {
    try {
      execFileSync('tar', ['-czf', sigOut, '-C', SIG_DIR, '.'], { stdio: 'ignore' });
      sigOk = true;
    } catch (e) {
      console.error('backup: signature tarball skipped (tar unavailable/failed):', e.message);
      fs.rmSync(sigOut, { force: true }); // never leave a partial archive
    }
  }

  prune();
  return { db: dbOut, signatures: sigOk ? sigOut : null, signature_count: sigs.length };
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
  // 03:15 local nightly via the shared in-process scheduler (DST-safe).
  // SCHEDULE_BACKUP=off disables it (e.g. when a host-side job owns backups);
  // the default 'nightly' preserves the historic behavior on every existing
  // install.
  const env = require('./env');
  if (env.SCHEDULE_BACKUP === 'off') return null;
  return require('./scheduler').scheduleDaily('backup', 3, 15, runBackup);
}

module.exports = { runBackup, scheduleNightly, BACKUP_DIR };

if (require.main === module) {
  const r = runBackup();
  console.log(`backup written:\n  ${r.db}\n  ${r.signatures || '(no signatures yet)'}`);
}
