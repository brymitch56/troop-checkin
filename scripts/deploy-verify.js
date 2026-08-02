#!/usr/bin/env node
'use strict';
// Cross-platform deploy-integrity verifier — the Node port of
// scripts/deploy-verify.sh, so Windows and Docker installs get the same
// post-update gate the Pi has. One implementation of each check; the bash
// wrapper stays for the Pi's existing muscle memory (it and this script
// verify the same things).
//
//   node scripts/deploy-verify.js [expected-HEAD-short] [expected-sw-version]
//
// Env overrides: PORT (default 3000), SERVICE (default troop-checkin),
// SKIP_SERVICE=1 to skip service/HTTP checks, DERBYNET_URL=skip to skip the
// DerbyNet coexistence check (it defaults to skipped everywhere except when
// explicitly set — that check is Pi-specific).
//
// Exits non-zero on any FAIL, so it can gate a deploy script on any OS.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

process.chdir(path.join(__dirname, '..'));

const [, , EXPECTED_HEAD, EXPECTED_SW] = process.argv;
const PORT = process.env.PORT || '3000';
const SERVICE = process.env.SERVICE || 'troop-checkin';
const BASE = `http://localhost:${PORT}`;
let FAIL = 0;

const ok = (m) => console.log(`[ok]   ${m}`);
const bad = (m) => { console.log(`[FAIL] ${m}`); FAIL = 1; };
const skip = (m) => console.log(`[skip] ${m}`);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

async function main() {
  // 1. Working tree must equal HEAD (catches 0-byte/truncated files post-pull)
  try {
    const dirty = git('status', '--porcelain', '--untracked-files=no');
    if (!dirty) ok('working tree matches HEAD (no modified tracked files)');
    else { bad('working tree differs from HEAD — corrupt or hand-edited files? Fix: git checkout -- <file>'); console.log(dirty.replace(/^/gm, '       ')); }
  } catch (e) { bad(`git status failed: ${e.message}`); }

  // 2. Expected HEAD
  try {
    const head = git('rev-parse', '--short', 'HEAD');
    if (!EXPECTED_HEAD) ok(`HEAD is ${head} (no expected hash passed)`);
    else if (head === EXPECTED_HEAD) ok(`HEAD is ${head} (expected)`);
    else bad(`HEAD is ${head}, expected ${EXPECTED_HEAD} — wrong revision deployed?`);
  } catch (e) { bad(`git rev-parse failed: ${e.message}`); }

  // 3. No zero-byte tracked source file
  try {
    const files = git('ls-files', '*.js', '*.sql', '*.json', '*.html', '*.css').split('\n').filter(Boolean);
    const zb = files.filter((f) => { try { return fs.statSync(f).size === 0; } catch { return true; } });
    if (!zb.length) ok('no zero-byte tracked source files');
    else { bad('zero-byte tracked source file(s) — restore with git checkout -- <file>:'); zb.forEach((f) => console.log(`       ${f}`)); }
  } catch (e) { bad(`zero-byte scan failed: ${e.message}`); }

  // 4. Critical modules load AND export what callers destructure
  try {
    const failures = require('../server/lib/selfcheck').runSelfCheck();
    if (!failures.length) ok('critical modules export their key functions (membership, rosterImport, sms, notifySweep)');
    else { bad('critical-module export check failed:'); failures.forEach((f) => console.log(`       ${f}`)); }
  } catch (e) { bad(`critical-module check crashed: ${e.message}`); }

  // 5. Migrations reconciled
  try {
    const { db } = require('../server/db');
    const all = fs.readdirSync(path.join('server', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    let applied = new Set();
    try { applied = new Set(db.prepare('SELECT name FROM schema_migration').all().map((r) => r.name)); }
    catch { /* table missing = nothing applied */ }
    const pending = all.filter((f) => !applied.has(f));
    if (!pending.length) ok('migrations reconciled (all files recorded in schema_migration)');
    else bad(`PENDING migration(s): ${pending.join(' ')} — run: npm run migrate`);
  } catch (e) { bad(`migration check failed: ${e.message}`); }

  // 6. Service + HTTP checks
  if (process.env.SKIP_SERVICE === '1') {
    skip('service/HTTP checks (SKIP_SERVICE=1)');
  } else {
    // service state: systemd only exists on Linux; elsewhere the HTTP checks
    // below are the liveness signal (Task Scheduler/Docker own the process)
    if (process.platform === 'linux') {
      try {
        execFileSync('systemctl', ['is-active', '--quiet', SERVICE]);
        ok(`service ${SERVICE} is active`);
      } catch {
        skip(`service ${SERVICE} not active via systemd (Docker or manual run?) — relying on HTTP checks`);
      }
    } else {
      skip(`systemd service check (${process.platform}) — relying on HTTP checks`);
    }

    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (r.ok && j.ok === true) ok(`healthz ok on :${PORT}`);
      else bad(`healthz failed on :${PORT} (HTTP ${r.status})`);
    } catch (e) { bad(`healthz failed on :${PORT}: ${e.message}`); }

    try {
      const sw = await (await fetch(`${BASE}/sw.js`, { signal: AbortSignal.timeout(5000) })).text();
      const served = (sw.match(/tc-v\d+/) || [])[0] || '';
      if (!EXPECTED_SW) ok(`served sw.js VERSION is ${served || '<none>'} (no expected version passed)`);
      else if (served === EXPECTED_SW) ok(`served sw.js VERSION is ${served} (expected)`);
      else bad(`served sw.js VERSION is '${served}', expected ${EXPECTED_SW} — stale service or bad pull?`);
    } catch (e) { bad(`sw.js fetch failed: ${e.message}`); }

    const derby = process.env.DERBYNET_URL;
    if (!derby || derby === 'skip') skip('DerbyNet check (DERBYNET_URL unset — Pi-specific)');
    else {
      try {
        const r = await fetch(derby, { signal: AbortSignal.timeout(5000) });
        if (r.status >= 200 && r.status < 400) ok(`DerbyNet answers at ${derby}`);
        else bad(`DerbyNet returned HTTP ${r.status} at ${derby}`);
      } catch (e) { bad(`DerbyNet unreachable at ${derby}: ${e.message}`); }
    }
  }

  console.log(FAIL ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(FAIL);
}

main();
