# Troop Check-In

Self-hosted youth sign-in/out kiosk for a Trail Life USA troop (or any similar youth program). Node + Express + SQLite on a Raspberry Pi; installable PWA on leaders' phones (Android + iOS). Youth PII never leaves your hardware except through authenticated access and your own backups.

Your troop's number and name live in `.env` — nothing troop-specific is hardcoded, so any troop can run this. See `docs/` (requirements, architecture, data model, build plan) for the full design.

## Status

**Working (all phases):** staff PIN login (door/admin roles) · roster xlsx import from the Trail Life Connect member export (preview + commit, archived originals) · guardian auto-linking (cc-email match, name/address fallback) with an authoritative admin-edited authorized list · badge scan via camera (BarcodeDetector, jsQR fallback) and Bluetooth HID scanners (keyboard wedge) · badge→member enrollment for new/reprinted badges · name search · multi-youth cart with one signature · authorized-signer check with audited staff override · emergency-contact capture with prefill · visitor quick-add and later merge into the roster · direction auto-detect with server-side race protection · manual events + iCal feed sync (nightly + on demand) · multi-day events (sign-out attaches through the open sign-in) · per-event adult attendance · per-device station mode (patrol-scoped views) · "still on site" view · admin UI (people, guardians, events, transaction browser with signatures, append-only void/close corrections, CSV reports, roster import) · nightly on-Pi backups · **offline-first**: the roster snapshots into IndexedDB and transactions queue locally when connectivity drops (campouts, basements), syncing automatically on reconnect with server-side dedupe and conflict flagging · vendored QR library (no CDN dependency on iOS) · kiosk idle auto-logout (20 min default; `localStorage['idle-minutes']` to change) · **SMS notifications** (Twilio; guardians of lingering youth get a text after the event ends and can reply Y to confirm pickup, STOP to opt out — off until `SMS_ENABLED=true`) · **consent-form authorized adults** (designees who aren't in Trail Life Connect, any name, added per youth in admin) · **field-level import locks** (hand-edited roster fields are never overwritten by re-imports; unlockable per person) · **reports** over the full history (date range / event / person; on-screen summary + detail & summary CSVs; records are never deleted) · optional **youth photos** shown at signature time for pickup confirmation.

**Remaining for production SMS:** complete Twilio A2P 10DLC registration, then fill the `TWILIO_*`/`PUBLIC_URL` values in `.env` and set `SMS_ENABLED=true` (see "SMS setup" below).

## Setup: fresh Pi to first meeting

1. Flash 64-bit Raspberry Pi OS Lite; boot; `sudo apt update && sudo apt install -y git`.
2. Clone and install (installs Node 20 LTS, dependencies, systemd service):

   ```bash
   git clone https://github.com/YOURNAME/troop-checkin.git
   cd troop-checkin
   sudo bash scripts/install-pi.sh
   ```

3. Edit `.env`: set `TROOP_ID` (e.g. `NY-2911`), `TROOP_NAME`, and `ICAL_URL` (your Trail Life Connect calendar feed) — then `sudo systemctl restart troop-checkin`.
4. Create staff accounts — door staff get a short PIN, admins a real password:

   ```bash
   npm run create-staff -- "Door Volunteer" door 1234
   npm run create-staff -- "Your Name" admin "a-strong-password"
   ```

5. From a phone on the same Wi-Fi, open `http://<pi-hostname>.local:3000` — sign in, and use the browser's "Add to Home Screen" to install the PWA. The admin area is at `/admin.html`.
6. Import your roster: Admin → **Roster import** → upload the Trail Life Connect member export (.xlsx) → review the preview (adds / updates / deactivations) → commit. Re-import any time you get a new export; your guardian/authorized-list edits are never overwritten. The uploaded file is archived under `data/` and stays out of git.

## Roster import expectations

The importer reads the standard Trail Life Connect member export: a title row, then a header row containing **Member Number** (located by name, so filtered exports work too), with the **Youth** Y/N column separating youth from adults. A youth's "Email" column is treated as a TLC username, not an email; guardians auto-link via **Adult Cc Email** matching an adult's Email, falling back to same last name or same address+zip. People absent from a newer file are marked inactive (never deleted); a youth-only export leaves adults untouched.

## Badge enrollment

Badges carry a QR payload of `<memberID> | <token>`. The first scan of a new badge whose member number matches the roster prompts "Link badge" — that's normal enrollment, and it repeats automatically when a badge is reprinted (same member number, new token). Any 2D/QR Bluetooth scanner in HID keyboard mode works; phone cameras work without extra hardware.

## Backups & restore

A nightly job (03:15) writes a consistent DB snapshot (`VACUUM INTO`) plus a tar of signature images to `data/backups/`, keeping the newest 14. Trigger one any time from Admin → Tools → **Back up now**, or `npm run backup`.

Getting them **off the Pi** is one rclone step (documented, not automated — you choose the destination):

```bash
sudo apt install -y rclone && rclone config   # e.g. an encrypted Google Drive remote
# cron, after the 03:15 backup:
# 45 3 * * * rclone copy /path/to/troop-checkin/data/backups remote:troop-backups
```

**Restore:** stop the service, copy the snapshot over `data/troop.db` (remove `troop.db-wal`/`-shm` if present), untar signatures into `data/signatures/`, start the service. Test this once before you need it.

## SMS setup (Twilio)

One-time, all in the [Twilio Console](https://console.twilio.com):

1. **Buy a phone number** (Phone Numbers → Buy a Number, ~$1.15/mo, SMS-capable, any US number).
2. **Register for A2P 10DLC** (required for US SMS delivery; Messaging → Regulatory Compliance). As an individual/troop use **Sole Proprietor** registration: one-time + small monthly fees, approval typically days. Create a "Messaging Service", attach your number, describe the use case as parent pickup notifications with an opt-in of "parents provide their number on a signed consent form"; sample message: "NY-2911: Alex S is still checked in after Troop Meeting ended. Reply Y once picked up. Reply STOP to opt out."
3. **Copy credentials** from the Console home page: Account SID (`AC…`) and Auth Token.
4. On the Pi, edit `.env`: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (the number you bought, `+1…` format), `PUBLIC_URL` (your Cloudflare tunnel origin, e.g. `https://checkin.example.org`), and `SMS_ENABLED=true`. Restart: `sudo systemctl restart troop-checkin`.
5. **Point the webhook at the app**: Phone Numbers → your number → Messaging → "A message comes in" → Webhook, `POST`, URL `<PUBLIC_URL>/api/sms/inbound`. (Requires the tunnel to be up; inbound requests are verified with Twilio's signature.)

Behavior: 30 min after an event ends (per-event override in the admin event editor), the primary authorized guardian of each youth still checked in gets one text. Reply **Y** closes the sign-in (recorded as `sms_confirm`); **STOP**/**START** manage opt-out. Everything is logged under Admin → Reports.

## Remote access (optional)

Expose through a Cloudflare Tunnel (`cloudflared` has arm64 builds); the app sets `Secure` on session cookies when served over HTTPS. Put Cloudflare Access in front of `/admin.html` and `/api/admin/*` before exposing the admin area publicly.

## Development

```bash
npm install && npm run migrate && npm start   # http://localhost:3000
npm test                                       # API + import + txn rule tests (node:test)
npm run make-roster                            # synthetic TLC-format roster (fake names)
npm install --no-save puppeteer && node test/e2e-browser.js   # browser E2E
```

Tests use synthetic data only — never commit a real roster; `.gitignore` blocks `data/`, `*.xlsx`, and signature images as a hard rule.

## Field notes

- **Mixed carts:** a cart is all-IN or all-OUT; the app tells you when a scanned person doesn't match the cart direction.
- **Emergency contact:** shown on every youth sign-in, prefilled from last use (falls back to the primary guardian's mobile); saved per event as a historical snapshot.
- **Station mode:** tap the patrol pill in the top bar to scope a device to one patrol for big events — scans still accept anyone.
- **Adults:** only tracked at events where the "adult attendance" toggle is on (set at event creation or in the admin UI); adults never sign.
- **Corrections:** transactions are append-only. Fix mistakes in Admin → Transactions with **Void** (adds a reversing record) or close a lingering sign-in from the Dashboard — both are recorded with your staff name.

## License

MIT — see `LICENSE`. Shareable with other troops; please keep the PII rules if you fork.
