# Troop Check-In App — Phased Build Plan

Draft v0.1

## Phase 0 — Foundations (one evening)
- Pi setup: Node LTS, SQLite, project scaffold, systemd service, git repo.
- Schema migration script from the data model doc.
- Decide domain name; create Cloudflare account + tunnel (can defer exposure until Phase 2).

**Exit test:** server runs on LAN, health endpoint responds, DB migrates cleanly.

## Phase 1 — Core check-in/out (MVP for a real meeting night)
- Staff login (PIN) + door/admin roles.
- Roster xlsx import with preview (add/update/deactivate) — format locked from the 07-19 sample export; handles mixed youth+adult and filtered files.
- Badge scan (BarcodeDetector + zxing fallback) plus Bluetooth HID keyboard-wedge input, badge→member enrollment flow, name-search fallback.
- Multi-youth cart, direction auto-detect, authorized-signer picker, emergency-contact field on every youth sign-in (prefill last-used → primary guardian mobile, editable, optional second number), signature capture, transaction save.
- Manual event creation; single-event auto-select.
- Visitor quick-add.
- "Who's still here" live view.

**Exit test:** run one full troop meeting on LAN Wi-Fi alongside the paper sheet; compare records.

## Phase 2 — Remote access, events, admin
- Cloudflare Tunnel live; Cloudflare Access on admin routes.
- iCal nightly sync (discrete events only — no RRULE handling needed); multi-event picker; multi-day event handling via open-sign-in attachment.
- Per-event toggle: adult attendance tracking (badge/name check-in, no signature).
- Per-device "station mode": a sign-out device scopes its roster view and "who's still here" list to one patrol while still accepting any scanned badge.
- Admin UI: roster, guardians/authorized lists, events, transaction browser with signature viewing, CSV exports, visitor merge.
- Nightly backup to Google Drive via rclone; restore procedure documented and tested once.

**Exit test:** sign a youth in Friday at a campout, out Sunday — record attaches to the right event. Restore a backup onto a scratch DB.

## Phase 3 — Notifications
- Start Twilio A2P 10DLC sole-prop registration early (approval takes days–weeks).
- Notification sweep cron; SMS send with opt-out handling (STOP).
- Inbound webhook with signature validation; "Y" reply closes open sign-ins.
- Notification log in admin; per-event notify-delay override.

**Exit test:** leave a test youth signed in past event end; confirm SMS arrives and a Y reply closes the record.

## Phase 4 — Offline-first & hardening
- Service worker: app-shell caching, roster snapshot, IndexedDB transaction queue, sync with client_uuid dedupe, conflict flagging.
- PWA install polish (manifest, icons, iOS meta tags), kiosk idle auto-logout, device registration tokens.
- Pi reliability: SSD boot or read-mostly SD, watchdog, monitoring ping (e.g., healthchecks.io on the backup cron).

**Exit test:** airplane-mode a tablet, run five transactions including a mixed cart, reconnect, verify clean sync.

## Phase 5 — Nice-to-haves (backlog)
- Push notifications to on-duty leaders for lingering open sign-ins (parents don't install the app; SMS remains their channel).
- Multi-troop events: check in/out youth from visiting troops without pre-loaded roster data — likely a "guest troop" grouping built on the visitor flow, with optional bulk pre-import from a shared sheet if other troopmasters provide one.
- Attendance reports/streaks for advancement tracking.
- Photo on youth profile for visual confirmation at pickup.
- Multi-device same-night stress features (cart handoff, second door).

## Risks & Mitigations
| Risk | Mitigation |
|---|---|
| iOS Safari camera/PWA quirks | test on an actual parent-typical iPhone in Phase 1, keep name-search fallback first-class |
| A2P registration delay/denial | phase 3 is isolated; app is fully useful without SMS |
| xlsx export format changes | import preview + audit copy of every uploaded file |
| Pi/home internet down at meeting | offline queue (Phase 4); before that, paper fallback sheet in the box |
| Badge QR payload format surprises | store raw payload verbatim; enrollment links payload→member so format never needs decoding |

## Immediate Next Steps
1. Get a sample roster xlsx export and one badge QR payload (scan with any QR reader app and paste the raw text).
2. Confirm the iCal feed URL is stable (events confirmed as individual, non-recurring).
3. Decide the domain name for the tunnel.
4. Decide Twilio now vs. later (registration lead time argues for starting the paperwork even if Phase 3 is months out).
