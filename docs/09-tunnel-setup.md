# Cloudflare Tunnel Setup Guide — Troop Check-In

Goal: `https://checkin.ny2911.org` reaches the Pi from anywhere, with no port forwarding. This unlocks everything currently dormant: HTTPS on phones (camera scanning, PWA install, offline mode), Twilio inbound (Y-replies, STOP tracking, broadcast replies into the Messages tab), and delivery receipts.

**Division of labor:** you do the Cloudflare dashboard and Twilio console parts (browser); Claude Code does the Pi parts (marked 🖥️). HostGator keeps hosting ny2911.org unchanged — only DNS moves to Cloudflare; the website and any @ny2911.org email stay where they are.

## Part A — Verify the DNS move (prerequisite, in progress)

The domain's *nameservers* point at Cloudflare; Cloudflare then serves the same records that point at HostGator. When your friend finishes the switch, verify before going further:

1. In the Cloudflare dashboard, the ny2911.org zone shows **Active** (not "Pending nameserver update").
2. Cloudflare → ny2911.org → **DNS → Records**: confirm the imported records match what HostGator had — especially:
   - the **A record** for `ny2911.org` (and `www`) pointing at HostGator's server IP (find it in HostGator cPanel under "Shared IP Address" if unsure);
   - **MX records** if anyone has @ny2911.org email — and set any mail-related records (`mail`, MX targets) to **DNS only** (grey cloud, not orange). Proxied mail records silently break email.
3. Sanity test: the ny2911.org website loads, and a test email to any @ny2911.org address arrives.

Nothing about the check-in app touches these records — the tunnel adds a new `checkin` subdomain alongside them.

## Part B — Create the tunnel (you: dashboard · Code: Pi)

1. Cloudflare dashboard → **Zero Trust** (left sidebar; create the free Zero Trust org if prompted — pick any team name, free plan).
2. **Networks → Tunnels → Create a tunnel** → type **Cloudflared** → name it `troop-checkin`.
3. The next screen shows install commands. Pick **Debian → arm64**. Copy the whole command (it contains the tunnel token) and **give it to Claude Code** — 🖥️ Code runs it on the Pi; it installs `cloudflared` as a service that auto-starts on boot and reconnects from any network (home now, church later — no router changes anywhere, ever).
4. Still in the tunnel wizard → **Public Hostnames → Add**:
   - Subdomain: `checkin` · Domain: `ny2911.org` · Path: (blank)
   - Service: Type **HTTP**, URL **`localhost:3000`**
5. Save. The dashboard should show the tunnel **HEALTHY** within a minute.
6. Quick test from any device (any network): `https://checkin.ny2911.org/healthz` → `{"ok":true}`.

## Part C — Protect the admin area (Cloudflare Access)

Put a login wall in front of admin **paths only** — the kiosk must stay reachable without extra challenges, and `/api/sms/inbound` must stay public for Twilio.

1. Zero Trust → **Access → Applications → Add an application** → **Self-hosted**.
2. Application name: `Troop Check-In Admin`. Session duration: 24 hours.
3. Add **two** public hostname entries on the application (Add public hostname / path):
   - `checkin.ny2911.org` path `/admin.html`
   - `checkin.ny2911.org` path `/api/admin/*` (use `/api/admin` if the UI wants a prefix rather than a wildcard)
4. Policy: name `Leaders`, action **Allow**, include → **Emails** → list your email and any other admins'. (Login method: the default **One-time PIN** emails a code — no passwords to manage.)
5. Leave everything else at defaults and save. **Do not** add an application covering `/` or the whole hostname.
6. Test: open `https://checkin.ny2911.org/admin.html` in a private window → Cloudflare asks for your email → emailed code → then the app's own admin login appears (two layers, by design). The kiosk at `https://checkin.ny2911.org/` must load with **no** Cloudflare challenge.

## Part D — 🖥️ Pi config (Claude Code)

In `~/troop-checkin/.env` add/set:

```
PUBLIC_URL=https://checkin.ny2911.org
```

then `sudo systemctl restart troop-checkin`. (With `PUBLIC_URL` set, the app validates Twilio webhook signatures and requests delivery receipts automatically; session cookies get the `Secure` flag over the tunnel on their own.)

## Part E — Twilio console changes (you)

1. **Point the reply webhook at the tunnel**: Phone Numbers → Manage → Active numbers → your campaign number → **Messaging Configuration** → "A message comes in" → **Webhook**, method **POST**, URL:
   `https://checkin.ny2911.org/api/sms/inbound` → Save.
2. That's the only required Twilio change. Delivery receipts need no console setup (the app attaches a status callback to each message it sends). The privacy/terms/consent-form URLs in your campaign stay on `brymitch56.github.io` — no change needed; if you later move those pages to ny2911.org, update the campaign links then.
3. If SMS wasn't fully activated yet, this is the moment to finish the activation addendum in `CLAUDE-CODE-PI-DEPLOY-HANDOFF.md` (env values + the safe self-test).

## Part F — Switch the phones to HTTPS

The HTTPS address is a new origin, so treat it as a fresh install on each leader phone:

1. **First**: on any phone still using `http://192.168.86.125:3000`, check the ⏳ queue pill is empty (no unsynced offline records), because the old origin's queue doesn't carry over.
2. Browse to `https://checkin.ny2911.org`, sign in, **Add to Home Screen** (this now works on iPhone and Android — it's HTTPS). Remove the old home-screen icon/bookmark to avoid confusion.
3. Re-set any per-device station patrol (that setting is per-origin).
4. From here on, phones use the HTTPS address **everywhere — including at church**. That's what enables camera scanning and offline mode.

## Part G — Verification checklist

- `https://checkin.ny2911.org/healthz` → ok, from a phone on cellular (not Wi-Fi)
- Kiosk loads with no Cloudflare challenge; admin.html requires the email code
- `curl -si -X POST https://checkin.ny2911.org/api/sms/inbound -d "From=%2B15550100000&Body=Y"` → **403** (unsigned correctly rejected)
- On an installed-PWA phone: 📷 camera scan works · airplane mode → app still opens and queues → sync on reconnect
- Run the SMS self-test (activation addendum): text arrives → reply Y → youth closes → Messages tab shows the whole exchange, with status advancing to **delivered**
- DerbyNet still fine (nothing here touches it)

## Troubleshooting

- **Error 1033** at checkin.ny2911.org: tunnel down — 🖥️ `sudo systemctl status cloudflared` on the Pi.
- **502**: tunnel up, app down — 🖥️ `sudo systemctl status troop-checkin`.
- **Admin page's own API calls blocked / login loop**: the Access app path config is off — it must cover `/admin.html` and `/api/admin/*` and nothing else.
- **Site "pending" / not resolving**: DNS move (Part A) not complete yet; nothing else will work until the zone is Active.
- **Email to @ny2911.org broke after the move**: MX/mail records missing or proxied (orange-clouded) in Cloudflare DNS — fix per Part A step 2.

## Later (optional)

- Move the SMS policy pages from github.io to ny2911.org and update the Twilio campaign links.
- Give DerbyNet a hostname on the same tunnel (e.g. `derby.ny2911.org` → `localhost:80`) and retire the old port forward.
