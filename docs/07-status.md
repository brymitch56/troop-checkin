# 07 — Project Status

**Date:** 2026-07-19 · **Repo:** github.com/brymitch56/troop-checkin (private) · **Build:** all phases implemented, awaiting real-world testing

## One-paragraph summary

The Troop Check-In app is feature-complete through the entire build plan (Phases 1–5 of doc 04) plus post-plan requirements added 2026-07-19: Twilio SMS pickup notifications with Y-reply confirmation, consent-form authorized adults, field-level protection of hand-edited roster data against re-imports, and multi-year reporting with filtered CSV exports. 46 automated tests and a 19-step real-browser E2E (including a full offline round-trip) pass; a fresh clone installs and runs cleanly. Nothing has yet been tested on real hardware, with the real roster, or at a real meeting — that is the next milestone.

## Feature status

| Area | State | Notes |
|---|---|---|
| Core check-in/out (cart, signatures, races, emerg. contact) | Built + automated tests | Needs a live meeting-night trial vs the paper sheet |
| Badges (camera + BT wedge, enrollment, reprints) | Built + tested in emulated browser | Needs real iPhone camera + real scanner hardware |
| Roster import (TLC xlsx, preview, archive) | Built + tested vs synthetic files | Needs one run with the real 07-19 export |
| Guardian auto-link + authoritative admin edits | Built + tested | — |
| Consent-form authorized adults (any name) | Built + tested | Admin → People → youth → "Add a new authorized adult" |
| Field-level import locks + per-person unlock | Built + tested | Locks shown as 🔒 in the person editor |
| Admin UI (people, events, txns, signatures, void/close, merge, import) | Built + E2E smoke | — |
| iCal sync (nightly + on demand, keep/flag rule) | Built + tested | Needs the real TLC feed URL in `.env` |
| Multi-day events, adult tracking, station mode | Built + tested | — |
| Reports (date range/event/person; summary + detail CSVs) | Built + tested | Records retained forever; 3+ year queries are just wider ranges |
| Offline-first (IndexedDB snapshot, txn queue, conflicts) | Built + E2E offline round-trip | Airplane-mode test on a real phone recommended |
| Backups (nightly VACUUM INTO + signatures tar, keep 14) | Built; restore tested | rclone off-device push is a documented manual step |
| SMS notifications (sweep, Y/STOP webhook, log) | Built + tested with fake creds | **Blocked on Twilio A2P 10DLC registration** — see README "SMS setup" |
| Youth photos at pickup | Built + tested | Optional; upload per youth in admin |
| Pi deployment (installer, systemd, npm ci lockfile) | Built; fresh-clone verified in sandbox | Needs a run on the actual Pi 3B+ |
| Idle auto-logout, vendored jsQR, PWA polish | Built | — |

## Not built (deliberate backlog)

Staff management UI (CLI script exists), web push to on-duty leaders, guest-troop groupings for multi-troop events, cart handoff between devices, advancement/streak analytics beyond the summary report.

## Operational to-dos (require Bryan / accounts / hardware)

1. Pi: flash, clone, `sudo bash scripts/install-pi.sh`, edit `.env` (TROOP_ID=NY-2911, TROOP_NAME, ICAL_URL), create staff.
2. Import the real roster via Admin → Roster import (preview first).
3. Cloudflare Tunnel + Access in front of `/admin.html` and `/api/admin/*`; set `PUBLIC_URL`.
4. Twilio: buy number, complete **A2P 10DLC sole-proprietor registration** (the long pole — start now), fill `TWILIO_*` in `.env`, set the inbound webhook, flip `SMS_ENABLED=true`.
5. rclone remote for off-device backups + cron line (README "Backups").
6. Device pass: install the PWA on an iPhone and an Android, run testing-guide walkthroughs 1, 2, and 7.
7. First live meeting alongside the paper sheet (Phase 1 exit test), then retire the paper.

## Quality state

`npm test`: 46/46. Browser E2E: 19/19 steps. Fresh clone → `npm ci` → migrate → start: verified. Known soft spots to watch during real-world testing: iOS Safari camera/PWA quirks (mitigated by name search + wedge scanning), first-ever run of the real roster export (parser was validated against the 07-19 sample layout), and SMS deliverability once A2P is approved.

## Key documents

01 requirements · 02 architecture · 03 data model · 04 build plan · 05 implementation reference (as built) · 06 testing guide (automated + manual walkthroughs) · README (setup for any troop). History: 8 commits, PII excluded from git by hard rule.
