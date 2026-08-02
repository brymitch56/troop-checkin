# Running on Windows

The check-in app runs first-class on Windows — an old desktop or laptop in
the meeting hall works fine as the server. Everything below is plain-language
and copy-pasteable; no Linux knowledge needed. (Linux/Raspberry Pi remains
the primary platform; macOS is not supported.)

## What you need

- A Windows 10 or 11 PC that can stay on during meetings (it can sleep
  between them — the app keeps no cloud state and starts in seconds).
- The PC and the phones/tablets used at the door on the same Wi-Fi network.

## Install (about 10 minutes)

1. **Install Node.js LTS.** Download the "LTS" Windows installer from
   <https://nodejs.org> and click through it (all defaults are fine).

2. **Get the app.** Download the latest release zip from the GitHub releases
   page and unzip it somewhere permanent, e.g. `C:\troop-checkin`.
   (Or `git clone` if you're comfortable with git.)

3. **Install dependencies and start it.** Open *Terminal* (or PowerShell):

   ```powershell
   cd C:\troop-checkin
   npm install --omit=dev
   npm start
   ```

   Windows Firewall will ask on first start — choose **Allow** for private
   networks so phones on your Wi-Fi can reach the app.

4. **Configure in the browser.** Open <http://localhost:3000> — the
   first-run **setup wizard** walks you through troop name, program colors
   (Trail Life / AHG presets, all customizable), timezone, and your admin
   account. It writes the configuration file for you; nothing to hand-edit.

5. **Connect the first phone.** On a phone on the same Wi-Fi, browse to
   `http://<pc-name>:3000` (find the PC name under Settings → System →
   About, or use its IP address). Use "Add to Home Screen" to install the
   app.

## Start automatically at boot (Task Scheduler)

So nobody has to remember to start it before a meeting:

1. Open **Task Scheduler** → **Create Task…**
2. *General* tab: name it `Troop Check-In`; select **Run whether user is
   logged on or not**.
3. *Triggers* tab: New… → **At startup**.
4. *Actions* tab: New… →
   - Program/script: `C:\Program Files\nodejs\node.exe`
   - Arguments: `server\index.js`
   - Start in: `C:\troop-checkin`
5. *Settings* tab: tick **If the task fails, restart every** 1 minute.
6. OK, enter your Windows password, done. Test with right-click → **Run**,
   then open <http://localhost:3000>.

Or create it in one PowerShell line (run as Administrator, adjust paths):

```powershell
schtasks /Create /TN "Troop Check-In" /SC ONSTART /RU SYSTEM ^
  /TR "\"C:\Program Files\nodejs\node.exe\" C:\troop-checkin\server\index.js"
```

## Scheduled jobs — no Task Scheduler needed

Nightly backups (03:15) run **inside the app** — nothing to set up. The
optional weekly roster sync also runs in-process: after saving your portal
credentials in Admin → Import, add this line to the `.env` file in the app
folder and restart:

```
SCHEDULE_ROSTER_SYNC=weekly
```

(Sundays 03:30. On the Pi this is a systemd timer instead; same behavior.)

## Where your data lives

Everything — database, signatures, backups — is in the `data\` folder inside
the app folder. **That folder is your youth PII**: protect it with a
Windows account that only leaders use (Windows has no equivalent of the
Pi's file-permission locks; account separation is the protection here), and
copy `data\backups\` somewhere safe periodically.

## Updating

```powershell
cd C:\troop-checkin
git pull          # or: unzip the new release over the folder (keep data\ and .env!)
npm install --omit=dev
npm run migrate
node scripts/deploy-verify.js
```

Restart the app (or the scheduled task). `deploy-verify.js` must print
`RESULT: PASS` before you trust the update — it's the same integrity gate
the Pi deployment uses.

## Removing the app

Uninstalling is manual but small — nothing is installed system-wide:

1. If you kept records you want, copy `data\backups\` somewhere safe first.
2. Task Scheduler → right-click the `Troop Check-In` task → Delete.
3. Delete the app folder (e.g. `C:\troop-checkin`) — that removes the app
   AND all its data.
4. Optionally uninstall Node.js from Settings → Apps if nothing else uses it.

## Optional layers

Everything optional works the same as on the other platforms — HTTPS/remote
access via Cloudflare Tunnel (`docs/09-tunnel-setup.md`; the `cloudflared`
Windows service replaces the Linux one), SMS via Twilio, automated roster
sync (`docs/10-roster-sync.md`). The app is fully useful without any of
them: check-in/out, signatures, roster, reports, and offline queueing all
work LAN-only with zero accounts or subscriptions.
