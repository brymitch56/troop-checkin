# 07 — Project Status

**Date:** 2026-07-26 (rev 6) · **Repo:** github.com/brymitch56/troop-checkin (private) · **Deployed:** live on the church-bound Pi 4 ("DerbyServer", also runs DerbyNet), commit `1302ab4`, schema through 007, sw `tc-v12`, real roster with membership dates (81/113) — **pushed but NOT yet deployed: integrity hardening + user guide (tc-v13) + automated roster sync (migration 008, sw tc-v14)**

## Where things stand

The app is deployed and in early real-world testing. Two field bugs were found and fixed during deployment (modal-scrim CSS overriding `hidden`; `crypto.randomUUID` missing in plain-HTTP contexts — both now regression-tested). The SMS system is fully built and **strictly opt-in** (per youth↔guardian pair, gated on stored signed consent forms); it awaits Twilio `.env` values + webhook, which in turn await the **Cloudflare Tunnel**, which awaits the **ny2911.org DNS move to Cloudflare** (in progress via Bryan's friend; HostGator keeps hosting). The A2P campaign is **approved**.

## Feature inventory (all built, tested: 97 node:test + 21-step browser E2E incl. offline round-trip)

- **Automated roster sync** (NEW, rev 6; spec `05-roster-sync.md` = repo `docs/10-roster-sync.md`): weekly systemd timer (`troop-roster-sync.timer`, Sun 03:30, Persistent, MemoryMax 256M, optional via `install-pi.sh --with-roster-sync`) or admin "Sync now" runs `server/scripts/fetch-roster.js` — Yii2 CSRF login (single attempt, no retry), 503-kickoff + status polling, byte sniffing (never trusts Content-Type), sanity gates + configurable row-count guard (`TLC_ROW_TOLERANCE` 20% default, strict while the TLC filter-persistence question is open). Success stages a **pending import** (migration 008; one at a time, newer replaces older and says so) shown in Admin → Import with the full diff + Approve/Discard; **the job never commits**. Last-run status/error surfaced in the UI; exports under `data/roster-exports/` mode 600, pruned at 56 days; `TLC_ENABLED=false` kill switch; no new dependencies. NOT yet enabled in production — needs TLC credentials in `.env` and the timer install, and the TLC filter-persistence question resolved before scheduling (Bryan testing separately).

Everything from rev 2, plus the deployment-era additions:

- **In-app user guide** (NEW, rev 5): `public/guide.html` — full two-part guide (kiosk for door staff; admin) + quick-reference and troubleshooting tables, linked from the kiosk footer ("User guide") and the admin header ("? Guide"), cached in the SW shell for offline, print CSS + print button. Troop-generic in source (brand injected from `/api/config` like the rest of the app). A **printed/branded copy** lives in the parent folder: `TroopCheckIn-User-Guide-NY-2911.pdf` (9 pages, regenerate via headless-Chrome print after guide edits). sw bumped to **tc-v13**.
- **Deploy-integrity hardening** (rev 5; prompted by the 0-byte `membership.js` catch during the 1302ab4 deploy): (1) fail-fast **startup self-check** (`server/lib/selfcheck.js`, runs before `app.listen`) — a corrupt/empty core module (`membership`, `rosterImport`, `sms`, `notifySweep`) makes the service exit 1 with `STARTUP SELF-CHECK FAILED: …` instead of booting "healthy" and crashing later; systemd retry keeps it loud in journalctl. (2) **GitHub Actions CI** (`.github/workflows/ci.yml`): required node:test gate + advisory (non-blocking) browser-E2E job on push/PR to main. (3) **`scripts/deploy-verify.sh`** — repo-versioned mirror of the on-Pi `~/troop-deploy-verify.sh` guard (tree==HEAD, no 0-byte tracked sources, module exports via the same selfcheck list, migrations reconciled, service/healthz/sw/DerbyNet), referenced from README + Pi guide so clones share the check. Tested incl. a real boot of a truncated copy (exit 1) and a healthy boot.
- **Membership-expiration alert** (rev 4, DEPLOYED): the TLC export's "Membership Exp." column imports into `person.membership_expires` (migration 007; normalized to ISO — verified on the real export, `09/16/2026`→`2026-09-16`, all 52 distinct dates parsed, 81/113 people carry one; respects field-level manual locks). Kiosk shows an orange tag on the cart row + a "Membership expires MMM D — renewal due" line in the sign modal for youth within 30 days (day-granular, expired included) — **non-blocking**, works offline via the roster snapshot. Admin: Reports → "Membership renewals" 30/60/90-day list (+ registered adults) with CSV, and a dashboard "renewals due ≤30 days" card. The real export includes long-expired memberships (2022–2025) — listing those is by design.

- **Consent/opt-in SMS system**: `sms_opt_in` per youth↔guardian pair; opt-in requires an uploaded signed consent form (`consent_form` table, one form covers many pairs); sends (auto-sweep + manual) go only to `yes`; compliance CSV export.
- **Grouped notifications**: one text per guardian listing all their lingering youth; one Y reply closes them all. Exactly one guardian per youth is texted (primary preferred, opted-in fallback).
- **Kiosk guardian texting**: "🔔 Text guardians" (lingering alerts, deduped) and "✉️ Message" (custom broadcasts — ETA updates; scopes: still-on-site or everyone-who-attended the current event); both report exactly who was NOT contacted and why.
- **Message log**: every SMS in/out in admin → Messages (15s auto-refresh); broadcast replies stored (no more canned-nag responses unless a pickup is actually pending); reply-from-admin with STOP honored; Twilio delivery receipts via `/api/sms/status` once PUBLIC_URL is set. Y replies act only on lingering alerts, never broadcasts.
- **Family guardian/consent dialog**: apply one adult + relationship + primary + opt-in + consent form to any set of youth in one transaction (`/api/admin/guardian-bulk`); person editor is itself a dialog, family dialog layers above it; standard close-on-save behavior.
- **Events UX**: day-granular past-hiding everywhere (multi-day events current through their finish date), soonest-first ordering, show-past toggles.
- **Staff management tab**: create/rename/deactivate, PIN-overrides-password convention with guards (no self-deactivate, last-admin protection).
- Earlier phases unchanged: kiosk check-in/out with signatures + races, badges (camera/wedge/enrollment), roster import with preview + field-level manual locks, iCal sync, station mode, offline queue, photos, reports over full history, backups (nightly + encrypted rclone to Drive, restore-tested).

## Deployment facts

Pi 4 `DerbyServer` at `192.168.86.125:3000` (DHCP-reserved), systemd `troop-checkin`, reboot-tested, DerbyNet coexisting on :80. Backups: 03:15 local + 03:45 encrypted rclone push to Drive (`gdrive-crypt`; password in Bryan's Bitwarden). Claude Code (separate session, SSH) handles all Pi work — see `CLAUDE-CODE-PI-DEPLOY-HANDOFF.md` (deployment record + SMS-activation addendum). Service-worker cache means every deploy needs a VERSION bump (repo at **tc-v13**; Pi serves tc-v12 until the next deploy) and two reloads on phones — bump only when `public/` client assets change. **Every deploy ends with the integrity guard**: `bash ~/troop-deploy-verify.sh <head> <sw>` on the Pi (mirrored in-repo at `scripts/deploy-verify.sh`) must print RESULT: PASS — it exists because a pull once left `membership.js` 0-byte while the service booted "healthy" (see the handoff doc's integrity-catch note).

## Blocked / waiting

1. **DNS move to Cloudflare** (friend, in progress) → then TUNNEL-SETUP-GUIDE.md end to end → unlocks HTTPS on phones (camera/PWA/offline), Twilio inbound (Y/STOP/replies), delivery receipts.
2. **SMS activation** after tunnel: `.env` TWILIO_* + PUBLIC_URL + SMS_ENABLED, webhook URL, safe self-test (activation addendum; visitor-with-Bryan's-number needs an opt-in + placeholder consent form now).
3. Consent forms: printed PDF ready (`NY-2911-Pickup-Authorization-SMS-Consent.pdf`); collection + entry via the family dialog is ongoing manual work.
4. First live meeting night alongside paper (testing-guide walkthrough #1).

## Next step

**Deploy hardening + guide + roster sync** (Claude Code / Pi session): `git pull`, `npm run migrate` (**migration 008 is new** — expect "applied 008_pending_import.sql"), restart, `bash ~/troop-deploy-verify.sh <new-head> tc-v14` → RESULT: PASS; first deploy with the startup self-check active, so confirm the service starts (healthz ok); phones reload twice (tc-v14). Roster-sync stays dormant until TLC credentials land in `.env` + `TLC_ENABLED=true` + `install-pi.sh --with-roster-sync` — and do NOT schedule it until the TLC filter-persistence test is resolved. Then: first live meeting night alongside paper.

## Backlog (unchanged)

Web push to on-duty leaders (revisit after real meetings), guest-troop groupings, cart handoff, advancement analytics, move policy pages from github.io to ny2911.org (then update Twilio campaign links).

## Key documents

Planning 01–04 · 05 implementation · 06 testing guide · **08 Pi setup** · **09 tunnel setup** · README · `CLAUDE-CODE-PI-DEPLOY-HANDOFF.md` (live deployment record) · `SESSION-NOTES.md` (session handoff) · policies site `brymitch56.github.io/ny2911-policies` (+ consent form specimen). Naming rule: **"Trail Life Troop NY-2911"** — "USA" only for the national org.
