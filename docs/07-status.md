# 07 — Project Status

**Date:** 2026-07-19 (rev 2) · **Repo:** github.com/brymitch56/troop-checkin (private) · **Build:** all phases implemented; SMS activation and real-world testing in progress

## One-paragraph summary

The Troop Check-In app is feature-complete through the entire build plan (Phases 1–5) plus the post-plan requirements: Twilio SMS pickup notifications with Y-reply confirmation, consent-form authorized adults, field-level protection of hand-edited roster data against re-imports, and multi-year reporting with filtered CSV exports. 46 automated tests and a 19-step real-browser E2E (including a full offline round-trip) pass; a fresh clone installs and runs cleanly. Twilio activation is underway: the A2P brand is registered (Sole Proprietor, "Trail Life NY-2911"), the campaign application materials are complete, and the required public policy pages, consent form, and form specimen are live. Remaining: campaign approval, Pi deployment, and live-meeting testing.

## Naming rule

The troop is always **"Trail Life Troop NY-2911."** "Trail Life USA" refers only to the national organization, never to any troop. This is enforced across the app, policies, and forms.

## SMS / Twilio activation state

Done: Twilio account funded; A2P Brand registered (Sole Proprietor); campaign registration text prepared (description, message flow, sample messages, opt-in keywords START/UNSTOP — deliberately excluding YES, which means "picked up" in this campaign — plus opt-out/help messages); public compliance pages **live** at `brymitch56.github.io/ny2911-policies/` (privacy.html, terms.html, consent-form.png, with site nav; source repo `ny2911-policies`, public, no PII); printable consent form PDF (`NY-2911-Pickup-Authorization-SMS-Consent.pdf`) meeting the full campaign checklist: checkbox + initials explicit consent, frequency, rates, HELP/STOP, links to both policies, date + signature, troop-use records line.

Remaining: submit/await campaign approval (days to ~2 weeks) · buy the sending number (if not already) · on the Pi set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `PUBLIC_URL`, `SMS_ENABLED=true` · point the number's "A message comes in" webhook at `<PUBLIC_URL>/api/sms/inbound` · run testing-guide walkthrough #8.

Note for the record: the policy site was briefly blocked by a GitHub account-level Actions/Pages hold (builds queued indefinitely or failed with no logs); it cleared after 2FA + payment-method verification. The first repo (`ny2911-sms-policies`) is superseded by `ny2911-policies` and can be deleted.

## Feature status

| Area | State | Notes |
|---|---|---|
| Core check-in/out (cart, signatures, races, emerg. contact) | Built + automated tests | Needs a live meeting-night trial vs the paper sheet |
| Badges (camera + BT wedge, enrollment, reprints) | Built + tested in emulated browser | Needs real iPhone camera + real scanner hardware |
| Roster import (TLC xlsx, preview, archive) | Built + tested vs synthetic files | Needs one run with the real export |
| Guardian auto-link + authoritative admin edits | Built + tested | — |
| Consent-form authorized adults (any name) | Built + tested | Paper form printed from the new PDF feeds this |
| Field-level import locks + per-person unlock | Built + tested | 🔒 shown in the person editor |
| Admin UI (people, events, txns, signatures, void/close, merge, import) | Built + E2E smoke | — |
| iCal sync (nightly + on demand, keep/flag rule) | Built + tested | Needs the real TLC feed URL in `.env` |
| Multi-day events, adult tracking, station mode | Built + tested | — |
| Reports (date range/event/person; summary + detail CSVs) | Built + tested | Records retained forever; 3+ year queries are just wider ranges |
| Offline-first (IndexedDB snapshot, txn queue, conflicts) | Built + E2E offline round-trip | Airplane-mode test on a real phone recommended |
| Backups (nightly VACUUM INTO + signatures tar, keep 14) | Built; restore tested | rclone off-device push is a documented manual step |
| SMS notifications (sweep, Y/STOP webhook, log) | Built + tested with fake creds | Awaiting campaign approval + `.env` values (see above) |
| SMS compliance collateral (policies site, consent form, specimen) | **Live / delivered** | `brymitch56.github.io/ny2911-policies/` |
| Youth photos at pickup | Built + tested | Optional; upload per youth in admin |
| Pi deployment (installer, systemd, npm ci lockfile) | Built; fresh-clone verified in sandbox | Needs a run on the actual Pi 3B+ |
| Idle auto-logout, vendored jsQR, PWA polish | Built | — |

## Not built (deliberate backlog)

Staff management UI (CLI script exists), web push to on-duty leaders, guest-troop groupings for multi-troop events, cart handoff between devices, advancement/streak analytics beyond the summary report.

## Operational to-dos (require Bryan / accounts / hardware)

1. Submit the Twilio campaign (all materials ready); on approval, finish SMS activation per the list above.
2. Print the consent form; collect signatures at the next meeting; enter authorized adults in Admin → People.
3. Pi: flash, clone, `sudo bash scripts/install-pi.sh`, edit `.env` (TROOP_ID=NY-2911 etc.), create staff.
4. Import the real roster via Admin → Roster import (preview first).
5. Cloudflare Tunnel + Access in front of `/admin.html` and `/api/admin/*`; set `PUBLIC_URL`.
6. rclone remote for off-device backups + cron line (README "Backups").
7. Device pass: install the PWA on an iPhone and an Android; run testing-guide walkthroughs 1, 2, 7.
8. First live meeting alongside the paper sheet (Phase 1 exit test), then retire the paper.
9. Optional cleanup: delete the superseded `ny2911-sms-policies` repo; later move policy pages to ny2911.org and update the campaign URLs.

## Quality state

`npm test`: 46/46. Browser E2E: 19/19 steps. Fresh clone → `npm ci` → migrate → start: verified. Watch during real-world testing: iOS Safari camera/PWA quirks (name search + wedge scanning are the fallback), first run of the real roster export, SMS deliverability once the campaign is approved.

## Key documents

01 requirements · 02 architecture · 03 data model · 04 build plan · 05 implementation reference · 06 testing guide · README (setup for any troop) · consent form PDF + policies site (`ny2911-policies` repo). History: 10 commits on the app repo, PII excluded from git by hard rule.
