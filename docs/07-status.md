# 07 — Project Status

**Date:** 2026-07-26 (rev 4) · **Repo:** github.com/brymitch56/troop-checkin (private) · **Deployed:** live on the church-bound Pi 4 ("DerbyServer", also runs DerbyNet), commit `3ce9668` — **membership-expiration feature is pushed but NOT yet deployed** (needs `git pull`, migration 007, restart, sw tc-v12)

## Where things stand

The app is deployed and in early real-world testing. Two field bugs were found and fixed during deployment (modal-scrim CSS overriding `hidden`; `crypto.randomUUID` missing in plain-HTTP contexts — both now regression-tested). The SMS system is fully built and **strictly opt-in** (per youth↔guardian pair, gated on stored signed consent forms); it awaits Twilio `.env` values + webhook, which in turn await the **Cloudflare Tunnel**, which awaits the **ny2911.org DNS move to Cloudflare** (in progress via Bryan's friend; HostGator keeps hosting). The A2P campaign is **approved**.

## Feature inventory (all built, tested: 64 node:test + 21-step browser E2E incl. offline round-trip)

Everything from rev 2, plus the deployment-era additions:

- **Membership-expiration alert** (NEW, rev 4): the TLC export's "Membership Exp." column imports into `person.membership_expires` (migration 007; normalized to ISO, defensive parsing; respects field-level manual locks). Kiosk shows an orange tag on the cart row + a "Membership expires MMM D — renewal due" line in the sign modal for youth within 30 days (day-granular, expired included) — **non-blocking**, works offline via the roster snapshot. Admin: Reports → "Membership renewals" 30/60/90-day list (+ registered adults) with CSV, and a dashboard "renewals due ≤30 days" card. Note: the real export's date FORMAT is unverified — the parser handles US M/D/YYYY, ISO, and Date-parseable strings, and keeps anything else raw (treated as "no date", never crashes); ask Claude Code for one sample value to confirm.

- **Consent/opt-in SMS system**: `sms_opt_in` per youth↔guardian pair; opt-in requires an uploaded signed consent form (`consent_form` table, one form covers many pairs); sends (auto-sweep + manual) go only to `yes`; compliance CSV export.
- **Grouped notifications**: one text per guardian listing all their lingering youth; one Y reply closes them all. Exactly one guardian per youth is texted (primary preferred, opted-in fallback).
- **Kiosk guardian texting**: "🔔 Text guardians" (lingering alerts, deduped) and "✉️ Message" (custom broadcasts — ETA updates; scopes: still-on-site or everyone-who-attended the current event); both report exactly who was NOT contacted and why.
- **Message log**: every SMS in/out in admin → Messages (15s auto-refresh); broadcast replies stored (no more canned-nag responses unless a pickup is actually pending); reply-from-admin with STOP honored; Twilio delivery receipts via `/api/sms/status` once PUBLIC_URL is set. Y replies act only on lingering alerts, never broadcasts.
- **Family guardian/consent dialog**: apply one adult + relationship + primary + opt-in + consent form to any set of youth in one transaction (`/api/admin/guardian-bulk`); person editor is itself a dialog, family dialog layers above it; standard close-on-save behavior.
- **Events UX**: day-granular past-hiding everywhere (multi-day events current through their finish date), soonest-first ordering, show-past toggles.
- **Staff management tab**: create/rename/deactivate, PIN-overrides-password convention with guards (no self-deactivate, last-admin protection).
- Earlier phases unchanged: kiosk check-in/out with signatures + races, badges (camera/wedge/enrollment), roster import with preview + field-level manual locks, iCal sync, station mode, offline queue, photos, reports over full history, backups (nightly + encrypted rclone to Drive, restore-tested).

## Deployment facts

Pi 4 `DerbyServer` at `192.168.86.125:3000` (DHCP-reserved), systemd `troop-checkin`, reboot-tested, DerbyNet coexisting on :80. Backups: 03:15 local + 03:45 encrypted rclone push to Drive (`gdrive-crypt`; password in Bryan's Bitwarden). Claude Code (separate session, SSH) handles all Pi work — see `CLAUDE-CODE-PI-DEPLOY-HANDOFF.md` (deployment record + SMS-activation addendum). Service-worker cache means every deploy needs a VERSION bump (currently **tc-v12** in the repo; the Pi serves tc-v11 until the next deploy) and two reloads on phones.

## Blocked / waiting

1. **DNS move to Cloudflare** (friend, in progress) → then TUNNEL-SETUP-GUIDE.md end to end → unlocks HTTPS on phones (camera/PWA/offline), Twilio inbound (Y/STOP/replies), delivery receipts.
2. **SMS activation** after tunnel: `.env` TWILIO_* + PUBLIC_URL + SMS_ENABLED, webhook URL, safe self-test (activation addendum; visitor-with-Bryan's-number needs an opt-in + placeholder consent form now).
3. Consent forms: printed PDF ready (`NY-2911-Pickup-Authorization-SMS-Consent.pdf`); collection + entry via the family dialog is ongoing manual work.
4. First live meeting night alongside paper (testing-guide walkthrough #1).

## Next step

**Deploy the membership-expiration feature** (Claude Code / Pi session): `git pull`, `npm run migrate` (applies the NEW migration 007), restart, confirm sw tc-v12, reload phones twice. Then re-import the current TLC roster export in Admin so `membership_expires` populates for the real 113 people, and confirm one sample date value parsed to ISO (headers/values stay on the Pi — a single date value, no name, is fine in transcripts).

## Backlog (unchanged)

Web push to on-duty leaders (revisit after real meetings), guest-troop groupings, cart handoff, advancement analytics, move policy pages from github.io to ny2911.org (then update Twilio campaign links).

## Key documents

Planning 01–04 · 05 implementation · 06 testing guide · **08 Pi setup** · **09 tunnel setup** · README · `CLAUDE-CODE-PI-DEPLOY-HANDOFF.md` (live deployment record) · `SESSION-NOTES.md` (session handoff) · policies site `brymitch56.github.io/ny2911-policies` (+ consent form specimen). Naming rule: **"Trail Life Troop NY-2911"** — "USA" only for the national org.
