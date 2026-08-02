# Troop Check-In

Self-hosted youth sign-in/out kiosk for Trail Life, American Heritage Girls, or any similar youth program. QR-badge check-in/out, parent signature capture on leaders' phones, roster management, reports — all on your own hardware. **Fully useful on your local network alone: no cloud, no accounts, no subscriptions.** Youth PII never leaves your hardware except through authenticated access and your own backups. MIT-licensed.

**New in this version: no file editing to get started.** Start the app, open it in a browser, and a first-run setup wizard configures everything — troop name, program colors (Trail Life / AHG presets, every color customizable), timezone, your admin account.

## Pick your hardware

Any of these works; the app is a single light Node process with SQLite:

- **Raspberry Pi** (the primary, battle-tested platform) — always-on, silent, ~2 W
- **A Windows PC** — the old laptop in the meeting-hall closet is plenty
- **Anything running Docker** — NAS, home server, 64-bit Pi with Docker

macOS is not supported as a server (Mac browsers work fine as clients).

## Quickstart A — Raspberry Pi

1. Flash 64-bit Raspberry Pi OS Lite; boot; `sudo apt update && sudo apt install -y git`.
2. Clone and install (installs Node 20 LTS, dependencies, systemd service):

   ```bash
   git clone https://github.com/brymitch56/troop-checkin.git
   cd troop-checkin
   sudo bash scripts/install-pi.sh
   ```

3. From any browser on the same network, open `http://<pi-hostname>.local:3000` — the setup wizard takes it from there.

Full walkthrough (including buying hardware and flashing the SD card): `docs/08-pi-setup-guide.md`.

## Quickstart B — Windows

1. Install [Node.js LTS](https://nodejs.org).
2. Download + unzip the latest release (e.g. to `C:\troop-checkin`), then in a terminal:

   ```powershell
   cd C:\troop-checkin
   npm install --omit=dev
   npm start
   ```

3. Open <http://localhost:3000> — the setup wizard takes it from there.

Run-at-boot via Task Scheduler and everything else Windows: `docs/11-windows.md`.

## Quickstart C — Docker

```bash
git clone https://github.com/brymitch56/troop-checkin.git
cd troop-checkin
docker compose up -d
```

Open `http://<host>:3000` — the setup wizard takes it from there. Volumes, backups, upgrades: `docs/12-docker.md`.

## After the wizard

1. Create door-staff accounts (short PINs for the sign-in stations) in Admin → Staff, or from the server: `npm run create-staff -- "Door Volunteer" door 1234`.
2. Import your roster: Admin → **Roster import** → upload your member-portal export (.xlsx) → review the preview → commit.
3. On each phone/tablet used at the door, open the app and "Add to Home Screen".

## Optional layers (each clearly skippable)

The core — check-in/out, signatures, roster, reports, offline queueing — needs none of these. Add them when (and if) you want them:

- **Internet access / HTTPS** via a free Cloudflare Tunnel: `docs/09-tunnel-setup.md`
- **SMS pickup notifications** via Twilio (strictly opt-in per family; US A2P registration required — the genuinely bureaucratic part): "SMS setup" below
- **Automated weekly roster sync** from your member portal: `docs/10-roster-sync.md`
- **Off-site encrypted backups** (rclone): `docs/08-pi-setup-guide.md`

Design documentation (requirements, architecture, data model, build plan) lives in `docs/`.

## Status

**Working (all phases):** staff PIN login (door/admin roles) · roster xlsx import from the Trail Life Connect member export (preview + commit, archived originals) · guardian auto-linking (cc-email match, name/address fallback) with an authoritative admin-edited authorized list · badge scan via camera (BarcodeDetector, jsQR fallback) and Bluetooth HID scanners (keyboard wedge) · badge→member enrollment for new/reprinted badges · name search · multi-youth cart with one signature · authorized-signer check with audited staff override · emergency-contact capture with prefill · visitor quick-add and later merge into the roster · direction auto-detect with server-side race protection · manual events + iCal feed sync (nightly + on demand) · multi-day events (sign-out attaches through the open sign-in) · per-event adult attendance · per-device station mode (patrol-scoped views) · "still on site" view · admin UI (people, guardians, events, transaction browser with signatures, append-only void/close corrections, CSV reports, roster import) · nightly on-Pi backups · **offline-first**: the roster snapshots into IndexedDB and transactions queue locally when connectivity drops (campouts, basements), syncing automatically on reconnect with server-side dedupe and conflict flagging · vendored QR library (no CDN dependency on iOS) · kiosk idle auto-logout (20 min default; `localStorage['idle-minutes']` to change) · **SMS notifications** (Twilio; guardians of lingering youth get a text after the event ends and can reply Y to confirm pickup, STOP to opt out — off until `SMS_ENABLED=true`) · **consent-form authorized adults** (designees who aren't in Trail Life Connect, any name, added per youth in admin) · **field-level import locks** (hand-edited roster fields are never overwritten by re-imports; unlockable per person) · **reports** over the full history (date range / event / person; on-screen summary + detail & summary CSVs; records are never deleted) · optional **youth photos** shown at signature time for pickup confirmation.

**Remaining for production SMS:** complete Twilio A2P 10DLC registration, then fill the `TWILIO_*`/`PUBLIC_URL` values in `.env` and set `SMS_ENABLED=true` (see "SMS setup" below).

## Updating & verifying a deploy

```bash
cd ~/troop-checkin && git pull && npm ci --omit=dev && npm run migrate && sudo systemctl restart troop-checkin
bash scripts/deploy-verify.sh            # optionally: <expected-head-short> <expected-sw-version>
```

On Windows/Docker the same gate is `node scripts/deploy-verify.js` — one implementation, every OS. `scripts/deploy-verify.sh` must print `RESULT: PASS` before you trust the deploy. It verifies the working tree exactly matches HEAD (catching 0-byte or truncated files from an interrupted pull), that critical server modules export what their callers depend on, that no database migration is pending, and that the service answers `healthz` and serves the expected `sw.js` version. On a dev machine run it with `SKIP_SERVICE=1`. As a second line of defense the server runs a startup self-check and refuses to boot (exit 1, clear `journalctl` message) if a core module is corrupt — a broken deploy fails loudly instead of crashing days later mid-meeting.

## Automated roster sync (optional)

A weekly job can fetch the member export from Trail Life Connect for you, so nobody has to remember to download-and-upload it. **What it does:** logs into TLC with credentials you put in `.env`, downloads the xlsx member export, validates it (byte sniffing, "Member Number" header check, minimum rows, and a row-count guard that refuses a file more than 20% smaller than the last one — a stale TLC filter could otherwise silently shrink your roster), archives it under the data directory, and stages the diff as a **pending import** in Admin → Import. **What it deliberately does not do:** commit. An admin always reviews the add/update/deactivate diff and taps Approve (or Discard) — the same preview/commit path as a manual upload, including field locks and guardian protections. It reads exactly one export and never writes anything to TLC.

Setup: enter the TLC login in Admin → Import → "Trail Life Connect credentials" (stored on the server, write-only — never displayed again; takes precedence over `.env`) or set `TLC_EMAIL`/`TLC_PASSWORD` in `.env`; make sure `TLC_ENABLED=true` (see `.env.example` for all knobs), then install the timer with `sudo bash scripts/install-pi.sh --with-roster-sync` — or run on demand with the **Sync now** button in Admin → Import (also `node server/scripts/fetch-roster.js`). The Import tab shows the last run's status and time, so a silently broken job is visible. **To disable:** set `TLC_ENABLED=false` (every run becomes a no-op), or `sudo systemctl disable --now troop-roster-sync.timer`, or simply never configure the credentials — the feature is fully optional. One TLC quirk to know: accounts with **multiple roles** sign in under whichever role was used last, and the export requires a role with member-list access (such as Troopmaster) — switch the account to that role in TLC before relying on the sync (fetch failures and suspiciously small files both point there first; a dedicated single-role account sidesteps it). If TLC ever adds MFA or a CAPTCHA, unattended login will stop working; fall back to manual upload. Full design notes: `docs/10-roster-sync.md`.

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
2. **Register for A2P 10DLC** (required for US SMS delivery; Messaging → Regulatory Compliance). As an individual/troop use **Sole Proprietor** registration: one-time + small monthly fees, approval typically days. Create a "Messaging Service", attach your number, describe the use case as parent pickup notifications with an opt-in of "parents provide their number on a signed consent form"; sample message: "NY-0000: Alex S is still checked in after Troop Meeting ended. Reply Y once picked up. Reply STOP to opt out."
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
