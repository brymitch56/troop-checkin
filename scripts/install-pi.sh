#!/usr/bin/env bash
# Troop Check-In — Raspberry Pi installer (Pi 3B+ or newer, 64-bit OS).
# Fresh clone → running service:
#   git clone https://github.com/YOURNAME/troop-checkin.git
#   cd troop-checkin && sudo bash scripts/install-pi.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-pi}"
NODE_MAJOR=20

echo "==> Troop Check-In installer (app: $APP_DIR, user: $RUN_USER)"

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
  scripts/troop-checkin.service.template > /etc/systemd/system/troop-checkin.service
systemctl daemon-reload
systemctl enable --now troop-checkin

# --- OPTIONAL: weekly Trail Life Connect roster sync ------------------------
# Skippable on purpose: a troop that doesn't want automated fetching should
# not be forced to configure TLC credentials. Enable now with
#   sudo bash scripts/install-pi.sh --with-roster-sync
# or later by re-running the installer with that flag. The job only ever
# stages a PREVIEW — an admin approves every import in the UI.
if [[ " ${*:-} " == *" --with-roster-sync "* ]]; then
  echo "==> Installing weekly roster-sync timer (runs Sundays 03:30)"
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@USER@|$RUN_USER|g" \
    scripts/troop-roster-sync.service.template > /etc/systemd/system/troop-roster-sync.service
  cp scripts/troop-roster-sync.timer.template /etc/systemd/system/troop-roster-sync.timer
  systemctl daemon-reload
  systemctl enable --now troop-roster-sync.timer
  echo "    Set TLC_EMAIL / TLC_PASSWORD in $APP_DIR/.env (chmod 600) or the job will fail cleanly."
  echo "    Disable any time: sudo systemctl disable --now troop-roster-sync.timer  (or TLC_ENABLED=false in .env)"
else
  echo "==> Roster-sync timer NOT installed (optional). Add later with:"
  echo "    sudo bash scripts/install-pi.sh --with-roster-sync"
fi
sleep 2
systemctl --no-pager status troop-checkin | head -8

echo
echo "==> Done. Next steps:"
echo "    1. Create staff:  cd $APP_DIR && npm run create-staff -- \"Full Name\" door 1234"
echo "                      npm run create-staff -- \"Admin Name\" admin \"a-strong-password\""
echo "    2. Edit .env (TROOP_ID, TROOP_NAME, ICAL_URL) then: sudo systemctl restart troop-checkin"
echo "    3. Open http://$(hostname).local:3000 from a phone on the same Wi-Fi."
