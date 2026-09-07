#!/usr/bin/env bash
# Troop Check-In — Raspberry Pi installer (Pi 3B+ or newer, 64-bit OS).
# Fresh clone → running service:
#   git clone https://github.com/YOURNAME/troop-checkin.git
#   cd troop-checkin && sudo bash scripts/install-pi.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-pi}"
NODE_MAJOR=20

# --name <service>: systemd unit base name (default troop-checkin). A SECOND
# instance on the same box (another troop/program, its own clone + .env with
# its own PORT) must use a different name or this installer would overwrite
# the first instance's unit. The roster-sync units follow the same base:
# <name>-roster-sync.service / .timer. See docs/08-pi-setup-guide.md.
NAME="troop-checkin"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --name=*) NAME="${1#--name=}"; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
if [[ ! "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  echo "Bad --name '$NAME' (letters, digits, - and _ only)" >&2; exit 1
fi
if [[ "$NAME" == *-roster-sync ]]; then echo "--name must not end in -roster-sync" >&2; exit 1; fi

echo "==> Troop Check-In installer (app: $APP_DIR, user: $RUN_USER, service: $NAME)"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install-pi.sh" >&2
  exit 1
fi

# --- Node 20 LTS (NodeSource; arm64-safe) ----------------------------------
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt $NODE_MAJOR ]]; then
  echo "==> Installing Node $NODE_MAJOR LTS"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "==> Node $(node -v), npm $(npm -v)"

# --- app dependencies (better-sqlite3 builds native on arm64) ---------------
apt-get install -y build-essential python3 >/dev/null
cd "$APP_DIR"
sudo -u "$RUN_USER" npm ci --omit=dev 2>/dev/null || sudo -u "$RUN_USER" npm install --omit=dev

# --- config + database ------------------------------------------------------
if [[ ! -f .env ]]; then
  sudo -u "$RUN_USER" cp .env.example .env
  echo "==> Created .env from .env.example — EDIT IT (troop id/name, iCal URL)."
fi
sudo -u "$RUN_USER" npm run migrate

# --- systemd service --------------------------------------------------------
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@USER@|$RUN_USER|g" \
  scripts/troop-checkin.service.template > "/etc/systemd/system/${NAME}.service"
systemctl daemon-reload
systemctl enable --now "$NAME"

# --- OPTIONAL: weekly Trail Life Connect roster sync ------------------------
# Skippable on purpose: a troop that doesn't want automated fetching should
# not be forced to configure TLC credentials. Enable now with
#   sudo bash scripts/install-pi.sh --with-roster-sync
# or later by re-running the installer with that flag. The job only ever
# stages a PREVIEW — an admin approves every import in the UI.
if [[ " ${*:-} " == *" --with-roster-sync "* ]]; then
  echo "==> Installing weekly roster-sync timer (runs Sundays 03:30)"
  SYNC="${NAME%-checkin}-roster-sync"   # troop-checkin → troop-roster-sync (historic name); foo → foo-roster-sync
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@USER@|$RUN_USER|g" \
    scripts/troop-roster-sync.service.template > "/etc/systemd/system/${SYNC}.service"
  cp scripts/troop-roster-sync.timer.template "/etc/systemd/system/${SYNC}.timer"
  systemctl daemon-reload
  systemctl enable --now "${SYNC}.timer"
  echo "    Set TLC_EMAIL / TLC_PASSWORD in $APP_DIR/.env (chmod 600) or the job will fail cleanly."
  echo "    Disable any time: sudo systemctl disable --now ${SYNC}.timer  (or TLC_ENABLED=false in .env)"
else
  echo "==> Roster-sync timer NOT installed (optional). Add later with:"
  echo "    sudo bash scripts/install-pi.sh --with-roster-sync"
fi
sleep 2
systemctl --no-pager status "$NAME" | head -8

echo
echo "==> Done. Next steps:"
echo "    1. Create staff:  cd $APP_DIR && npm run create-staff -- \"Full Name\" door 1234"
echo "                      npm run create-staff -- \"Admin Name\" admin \"a-strong-password\""
echo "    2. Edit .env (TROOP_ID, TROOP_NAME, ICAL_URL) then: sudo systemctl restart $NAME"
APP_PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"'"'"' ')"
echo "    3. Open http://$(hostname).local:${APP_PORT:-3000} from a phone on the same Wi-Fi."
