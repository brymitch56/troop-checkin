# NY-2911 Troop Check-In

Self-hosted youth sign-in/out kiosk for Trail Life Troop NY-2911. Node + Express + SQLite on a Raspberry Pi; installable PWA on leaders' phones (Android + iOS). See the planning docs (requirements, architecture, data model, build plan) for the full design.

## Status: Phase 1 core

Working: staff PIN login (door/admin roles) · roster xlsx import (preview + commit, validated against the 07-19-2026 export) · guardian auto-linking (email match + name/address fallback; 50/50 on the sample file) · badge scan via camera (BarcodeDetector, jsQR fallback) and Bluetooth HID scanners (keyboard wedge) · badge→member enrollment for new/reprinted badges · name-search fallback · multi-youth cart with one signature · authorized-signer picker with per-youth check + staff override · emergency-contact capture with prefill · visitor quick-add (youth w/ guardian, or adult by name) · direction auto-detect with server-side race protection · manual events + auto-select of the current event · "still on site" view with patrol filter · adult attendance (no signature).

Not yet built (see build plan): iCal sync (Phase 2) · admin UI beyond import endpoint (Phase 2) · Cloudflare Access on admin routes (Phase 2) · SMS notifications (Phase 3) · offline transaction queue (Phase 4 — the shell caches, but submitting requires connectivity) · vendored jsQR (currently loaded from cdnjs when BarcodeDetector is unavailable, i.e. iOS).

## Raspberry Pi setup

```bash
# 64-bit Raspberry Pi OS Lite assumed
sudo apt update && sudo apt install -y git build-essential python3
# Node LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# app
cd /opt && sudo git clone <your-repo> troop-checkin && cd troop-checkin
sudo chown -R $USER . 
npm install                 # better-sqlite3 compiles or uses arm64 prebuilds
npm run migrate             # creates data/troop.db
npm run create-staff -- "Bryan" admin <password>
npm run create-staff -- "Door Volunteer" door 1234
npm start                   # listens on :3000
```

Visit `http://<pi>:3000` on the LAN. Sign in as admin, then import the roster:

```bash
curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"staff_id":1,"pin":"<password>"}'
curl -b cookies.txt -F file=@NY-2911_Members_MM-DD-YYYY.xlsx \
  'http://localhost:3000/api/roster/import?mode=preview'   # review the diff
curl -b cookies.txt -F file=@NY-2911_Members_MM-DD-YYYY.xlsx \
  'http://localhost:3000/api/roster/import?mode=commit'
```

(The Phase 2 admin UI replaces the curl steps with an upload page.)

### systemd

```ini
# /etc/systemd/system/troop-checkin.service
[Unit]
Description=Troop Check-In
After=network.target
[Service]
WorkingDirectory=/opt/troop-checkin
ExecStart=/usr/bin/node server/index.js
Restart=always
Environment=PORT=3000
User=pi
[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now troop-checkin`

### Cloudflare Tunnel (remote access)

```bash
# install cloudflared (arm64 .deb from Cloudflare), then:
cloudflared tunnel login
cloudflared tunnel create troop-checkin
cloudflared tunnel route dns troop-checkin checkin.<yourdomain>
# config: service http://localhost:3000
sudo cloudflared service install
```

Add Cloudflare Access in front of `/api/roster/*` and future `/admin/*` before exposing publicly (Phase 2 hardening).

## Field notes

- **Badges:** first scan of a fresh badge whose member number matches the roster prompts "Link badge" — that's normal enrollment, and it repeats automatically when a badge is reprinted (new token, same member number).
- **Bluetooth scanners:** pair in HID mode; any 2D/QR-capable model works. On iPhone, use the scanner's iOS keyboard-toggle button when you need the on-screen keyboard for name search.
- **Mixed carts:** a cart is all-IN or all-OUT; the app tells you when a scanned person doesn't match the cart direction.
- **Emergency contact:** shown on every youth sign-in, prefilled from last use (falls back to the primary guardian's mobile); saved per event as a historical snapshot.
- **Backups:** nightly `sqlite3 data/troop.db "VACUUM INTO 'backup.db'"` + tar `data/signatures` → rclone to Drive (Phase 2 cron script to come). Everything lives under `data/`.
