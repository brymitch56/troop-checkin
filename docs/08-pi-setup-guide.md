# Pi Setup Guide — Troop Check-In

Single-purpose guide: from an empty Raspberry Pi to the check-in app running at a troop meeting. Nothing else is in scope here (SMS activation, tunnel, and testing have their own docs). Everything below is copy-paste-able in order.

**You need:** Raspberry Pi 3 (A+ or B+) or newer · 16 GB+ microSD (or SSD) · power supply · your Wi-Fi name/password · a computer with the Raspberry Pi Imager · your GitHub login (the app repo is private).

> **Pi 3 Model A+ note:** works fine headless (no USB peripherals needed; Wi-Fi only). It has 512 MB RAM, so **before step 4** enlarge swap so the install can't run out of memory:
>
> ```bash
> sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
> sudo systemctl restart dphys-swapfile
> ```

## 0. Using an existing Pi (e.g., the DerbyNet Pi 4)

Already-running Pi with Raspberry Pi OS? Skip steps 1–2 entirely — SSH in and start at step 3. Coexistence notes:

- The app uses port **3000** and its own systemd service; it does not touch Apache/DerbyNet or ports 80/443. Confirm 3000 is free first: `ss -tln | grep 3000` (no output = free).
- Keep your existing IP reservation and DerbyNet port forwarding as-is. Do **not** forward port 3000 for remote access — use a Cloudflare Tunnel instead (outbound-only, HTTPS, no router changes; see README "Remote access").
- Plan for the tunnel before the first full meeting: phone browsers require HTTPS for camera scanning, PWA install, and offline mode. On plain `http://<pi-ip>:3000` everything else works (PIN login, name search, Bluetooth wedge scanning, signatures, admin).
- Shared device = push backups off the Pi (README "Backups", rclone) since the SD card now serves two jobs.

## 1. Flash the operating system

1. Install **Raspberry Pi Imager** on your computer (raspberrypi.com/software).
2. Choose Device: your Pi model. Choose OS: **Raspberry Pi OS Lite (64-bit)** — under "Raspberry Pi OS (other)". Choose Storage: the SD card.
3. Click **Next → Edit Settings** and set: hostname `checkin` · enable SSH (password) · username `pi` + a password you'll remember · your Wi-Fi SSID/password and country `US` · locale/timezone.
4. Write, then put the card in the Pi and power it on. Give it two minutes.

## 2. Connect to the Pi

From your computer (same network):

```bash
ssh pi@checkin.local
```

If `checkin.local` doesn't resolve (some Windows/Android networks), find the Pi's IP in your router's device list and `ssh pi@<that-ip>` instead. Note the IP — phones will use it too.

## 3. Get the code (private repo — needs GitHub sign-in)

```bash
sudo apt update && sudo apt install -y git
# GitHub CLI to authenticate the private clone:
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install -y gh
gh auth login        # GitHub.com → HTTPS → Login with a web browser → follow the code
gh repo clone brymitch56/troop-checkin
cd troop-checkin
```

## 4. Run the installer

```bash
sudo bash scripts/install-pi.sh
```

This installs Node 20, builds dependencies, creates `.env` from the example, sets up the database, and installs + starts the `troop-checkin` service (auto-starts on every boot). It ends by printing the next steps.

## 5. Configure `.env`

```bash
nano .env
```

Set at minimum:

```
TROOP_ID=NY-2911
TROOP_NAME=Trail Life Troop NY-2911
ICAL_URL=<your Trail Life Connect calendar feed URL>
```

Leave the `SMS_*`/`TWILIO_*`/`PUBLIC_URL` lines alone until the Twilio campaign is approved (see PROJECT-STATUS.md). Then:

```bash
sudo systemctl restart troop-checkin
```

## 6. Create staff accounts

```bash
npm run create-staff -- "Door Volunteer" door 1234
npm run create-staff -- "Bryan" admin "a-strong-password"
```

Door staff get a short PIN for the kiosk; admins get a real password for `/admin.html`. Repeat per person — everyone should have their own login (actions are recorded by name).

## 7. Verify and set up phones

1. On the Pi: `curl http://localhost:3000/healthz` → should print `{"ok":true}`.
2. On a phone (same Wi-Fi): open `http://checkin.local:3000` (or `http://<pi-ip>:3000`). Sign in with a door account.
3. Install as an app: iPhone Safari → Share → **Add to Home Screen**; Android Chrome → menu → **Add to Home screen**. Do this on every leader phone that will run check-in — installing also enables offline mode.
4. Admin area: `http://checkin.local:3000/admin.html`.

## 8. Load the roster

Admin → **Roster import** → upload the Trail Life Connect member export (.xlsx) → check the preview (adds/updates/deactivations) → **Commit**. Then in Admin → People, add authorized pickup adults from the signed consent forms.

## Day-to-day service commands

```bash
sudo systemctl status troop-checkin     # is it running?
sudo systemctl restart troop-checkin    # after any .env change
journalctl -u troop-checkin -f          # live logs (Ctrl-C to exit)
cd ~/troop-checkin && git pull && npm ci --omit=dev && npm run migrate && sudo systemctl restart troop-checkin   # update to latest code
```

Backups write themselves nightly to `~/troop-checkin/data/backups/` (kept: 14). Remote access via Cloudflare Tunnel is covered in the README ("Remote access").

## Push backups to Google Drive (encrypted)

One-time setup on the Pi. Backups contain youth PII, so they go up encrypted — Google only ever sees scrambled files that rclone (with your password) can decrypt.

```bash
sudo apt install -y rclone
rclone config
```

Walk through the prompts twice, creating two remotes:

1. **The Drive connection** — `n` (new remote) · name: `gdrive` · storage: `drive` (Google Drive) · leave client_id/secret/scope blank (defaults) · "Use web browser to automatically authenticate?" → **No** (the Pi is headless). It prints an `rclone authorize "drive" ...` command: run that on your Windows PC (install rclone there from rclone.org/downloads), sign in to your Google account in the browser that opens, and paste the resulting token back into the Pi prompt. Not a shared/team drive → `n`.
2. **The encryption layer** — `n` again · name: `gdrive-crypt` · storage: `crypt` · remote to encrypt: `gdrive:troop-checkin-backups` · encrypt filenames: standard · directory names: yes · then set a password (and optional salt). **Write this password down somewhere safe outside the Pi — without it, backups are unrecoverable.**

Test it, then schedule it right after the 03:15 nightly backup:

```bash
rclone copy ~/troop-checkin/data/backups gdrive-crypt: --min-age 1m && rclone ls gdrive-crypt: | head
crontab -e    # add this line:
# 45 3 * * * rclone copy /home/pi/troop-checkin/data/backups gdrive-crypt: --min-age 1m --log-file /home/pi/rclone-backup.log
```

In Drive you'll see a `troop-checkin-backups` folder full of gibberish names — that's correct; it's the encryption. **Restore test (do once now):** on the Pi, `rclone copy gdrive-crypt:troop-<latest-stamp>.db /tmp/` and confirm the file opens (`sqlite3 /tmp/troop-*.db "SELECT COUNT(*) FROM person;"` or just check its size matches). Recovery on a brand-new Pi = install rclone, recreate the two remotes with the same password, pull the files, follow README "Restore".

## If something goes wrong

- **Installer fails building `better-sqlite3`:** usually low memory on a 3B+ — `sudo systemctl stop troop-checkin` isn't needed; just re-run the installer; if it persists: `sudo apt install -y build-essential python3` and run it again.
- **Phone can't reach `checkin.local`:** use the IP address; consider reserving a fixed IP for the Pi in your router.
- **Service won't start:** `journalctl -u troop-checkin -n 50` shows why — most often a typo in `.env`.
- **Fresh start:** stop the service, delete `~/troop-checkin/data/` (this erases all records — only before go-live!), then `npm run migrate` and re-create staff.

Once this page is done, the app is meeting-ready: run testing-guide walkthrough #1 (docs/06-testing-guide.md) alongside the paper sheet at the first live night.
