#!/usr/bin/env bash
# Deploy-integrity verifier for troop-checkin.
#
# Mirrors the on-Pi guard (~/troop-deploy-verify.sh, added 2026-07-26 after a
# git pull left server/lib/membership.js as a 0-byte file that booted
# "healthy" and would only have crashed on the first roster import). Run it
# after `git pull` + `npm run migrate` + service restart, before trusting a
# deploy. Exits non-zero on any failure, so it can be chained:
#
#   bash scripts/deploy-verify.sh [expected-HEAD-short] [expected-sw-version]
#   e.g. bash scripts/deploy-verify.sh 1302ab4 tc-v12
#
# Environment overrides: PORT (default 3000), SERVICE (default troop-checkin),
# DERBYNET_URL (default http://localhost:80; set to "skip" to skip),
# SKIP_SERVICE=1 to skip the service/HTTP checks (e.g. on a dev machine).
set -u
cd "$(dirname "$0")/.."

EXPECTED_HEAD="${1:-}"
EXPECTED_SW="${2:-}"
PORT="${PORT:-3000}"
SERVICE="${SERVICE:-troop-checkin}"
DERBYNET_URL="${DERBYNET_URL:-http://localhost:80}"
BASE="http://localhost:${PORT}"
FAIL=0

ok()   { echo "[ok]   $*"; }
bad()  { echo "[FAIL] $*"; FAIL=1; }
skip() { echo "[skip] $*"; }

# 1. Working tree must equal HEAD (the core catch: any 0-byte / truncated /
#    partially-written tracked file shows up as modified after a clean pull).
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -z "$DIRTY" ]; then
  ok "working tree matches HEAD (no modified tracked files)"
else
  bad "working tree differs from HEAD — corrupt or hand-edited files? Fix: git checkout -- <file>"
  echo "$DIRTY" | sed 's/^/       /'
fi

# 2. Expected HEAD (when passed).
HEAD_SHORT="$(git rev-parse --short HEAD)"
if [ -n "$EXPECTED_HEAD" ]; then
  if [ "$HEAD_SHORT" = "$EXPECTED_HEAD" ]; then
    ok "HEAD is $HEAD_SHORT (expected)"
  else
    bad "HEAD is $HEAD_SHORT, expected $EXPECTED_HEAD — wrong revision deployed?"
  fi
else
  ok "HEAD is $HEAD_SHORT (no expected hash passed)"
fi

# 3. No zero-byte tracked source file.
ZB="$(git ls-files '*.js' '*.sql' '*.json' '*.html' '*.css' | while read -r f; do
  [ -s "$f" ] || echo "$f"
done)"
if [ -z "$ZB" ]; then
  ok "no zero-byte tracked source files"
else
  bad "zero-byte tracked source file(s) — restore with git checkout -- <file>:"
  echo "$ZB" | sed 's/^/       /'
fi

# 4. Critical modules load AND export what callers destructure. Reuses the
#    same list as the boot-time self-check (server/lib/selfcheck.js) so the
#    two can never drift; if selfcheck.js itself is corrupt this fails too.
if node -e '
  const failures = require("./server/lib/selfcheck").runSelfCheck();
  if (failures.length) { failures.forEach((f) => console.error("       " + f)); process.exit(1); }
' 2>&1; then
  ok "critical modules export their key functions (membership, rosterImport, sms, notifySweep)"
else
  bad "critical-module export check failed (see lines above)"
fi

# 5. Migrations reconciled: every server/migrations/*.sql must be recorded in
#    schema_migration (never trust a release note's \"should say up to date\").
PENDING="$(node -e '
  const fs = require("fs");
  const { db } = require("./server/db");
  const files = fs.readdirSync("server/migrations").filter((f) => f.endsWith(".sql")).sort();
  let applied = new Set();
  try { applied = new Set(db.prepare("SELECT name FROM schema_migration").all().map((r) => r.name)); }
  catch { /* table missing = nothing applied */ }
  console.log(files.filter((f) => !applied.has(f)).join(" "));
')"
if [ -z "$PENDING" ]; then
  ok "migrations reconciled (all files recorded in schema_migration)"
else
  bad "PENDING migration(s): $PENDING — run: npm run migrate"
fi

# 6. Service + HTTP checks (skipped off-Pi with SKIP_SERVICE=1).
if [ "${SKIP_SERVICE:-0}" = "1" ] || ! command -v systemctl >/dev/null 2>&1; then
  skip "service/HTTP checks (SKIP_SERVICE=1 or no systemctl — dev machine?)"
else
  if systemctl is-active --quiet "$SERVICE"; then
    ok "service $SERVICE is active"
  else
    bad "service $SERVICE is NOT active — journalctl -u $SERVICE -n 50"
  fi
  if curl -fsS --max-time 5 "$BASE/healthz" | grep -q '"ok":true'; then
    ok "healthz ok on :$PORT"
  else
    bad "healthz failed on :$PORT"
  fi
  SW_SERVED="$(curl -fsS --max-time 5 "$BASE/sw.js" | grep -o "tc-v[0-9]*" | head -1)"
  if [ -n "$EXPECTED_SW" ]; then
    if [ "$SW_SERVED" = "$EXPECTED_SW" ]; then
      ok "served sw.js VERSION is $SW_SERVED (expected)"
    else
      bad "served sw.js VERSION is '$SW_SERVED', expected $EXPECTED_SW — stale service or bad pull?"
    fi
  else
    ok "served sw.js VERSION is ${SW_SERVED:-<none>} (no expected version passed)"
  fi
  if [ "$DERBYNET_URL" = "skip" ]; then
    skip "DerbyNet check"
  else
    CODE="$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$DERBYNET_URL" || echo 000)"
    if [ "$CODE" = "200" ]; then
      ok "DerbyNet still answers 200 at $DERBYNET_URL"
    else
      bad "DerbyNet returned $CODE at $DERBYNET_URL (co-hosted service — check it)"
    fi
  fi
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL"
fi
exit "$FAIL"
