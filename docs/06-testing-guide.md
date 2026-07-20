# 06 — Testing Guide

Two layers: the automated suite (run it after any change), and manual walkthroughs (run these on real devices before relying on a feature at a meeting). All test data must be fake — never use the real roster in tests.

## Automated tests

```bash
npm test                      # 46 node:test cases across 5 files
npm install --no-save puppeteer
node test/e2e-browser.js      # 19-step real-browser E2E (kiosk + admin + offline)
```

What they cover: roster parser and guardian-link rules; import idempotency, deactivation scoping, field locks; every API endpoint over HTTP including all `/txn` business rules (signer requirements, authorization + override, 409 races, dedupe, FR-12 adults); admin flows (guardian authority, void/close corrections, merge, CSVs, iCal apply rules, backup restore); Twilio signature validation and Y/STOP webhook flows; report filters; photo upload and gating. The E2E drives a real Chrome through login, wedge scanning, badge enrollment, cart, signature canvas, override confirm, station mode, the admin UI, and a full offline round-trip (queue → reconnect → sync).

Everything runs against a throwaway `DATA_DIR` in `/tmp` — your real database is never touched. A fresh-clone check (`git clone … && npm ci && npm run migrate && npm start`) should also pass after any dependency change; this is what the Pi installer does.

## Manual test walkthroughs

Setup once: `npm run migrate`, create one door and one admin account (`npm run create-staff`), start the server, and in Admin → Roster import upload a **synthetic** roster (`npm run make-roster` writes `data/synthetic-roster.xlsx`).

### 1. Meeting night (core loop)
1. Phone on the same Wi-Fi → open the app → tap door staff name, enter PIN.
2. Confirm the current event auto-selected (create one first via the event pill if needed).
3. Search a youth by name → add to cart → an emergency-phone field appears, prefilled after first use.
4. Add a second youth, tap Sign IN → pick the guardian → draw a signature → Save.
5. "On site" pill increments. Tap it: both youths listed under the event; patrol filter works.
6. Sign one out (search → cart shows OUT → guardian + signature). On-site count drops.
7. Try signing the same youth out again → friendly "already signed out" message.

### 2. Badges & scanners
1. Admin: note a youth's member number; make a QR of `<memberID> | <anything>` (any QR generator).
2. Kiosk → 📷 Scan badge → point camera → "Link badge" prompt appears (first scan) → confirm → youth lands in the cart.
3. Re-scan → straight to cart (now linked). A QR with the same member ID but different token offers to re-link (reprint flow).
4. Bluetooth scanner (HID mode): scan while no field is focused → same behavior. Scan **while the search field is focused** → the field must stay clean.
5. Type a PIN or search normally — nothing should ever eat typed characters.

### 3. Visitors & merge
1. Kiosk → + Visitor → youth with guardian name/phone → sign them in (guardian appears as signer).
2. Later: Admin → People → filter status=visitor → open them → "Merge into roster member…" → their attendance history moves to the roster youth.

### 4. Authorized adults / consent forms
1. Admin → People → open a youth. In "Guardians & authorized pickup":
   - revoke a parent (✓ yes — revoke) → kiosk signer list no longer offers them without override;
   - "Add a new authorized adult" with a completely different last name → they appear in the kiosk signer picker immediately;
   - make them primary → old primary demotes automatically.
2. Re-import the roster → verify none of those edits reverted (source shows `manual`).

### 5. Roster edits & import locks
1. Admin → People → open someone → change patrol/phone → Save. A 🔒 appears on the field and the lock list at the bottom.
2. Re-import the roster export → the locked field keeps your value; unlocked fields still update from the file.
3. "let imports manage these again" → re-import → file values return.

### 6. Events & iCal
1. Set `ICAL_URL` in `.env`, restart → Admin → Tools → Sync iCal now → events appear (source `ical`).
2. Remove an event from the TLC calendar → next sync deletes it if unused, or flags "gone from feed" if it has transactions.
3. Create a multi-day event (campout) with adult tracking on. Sign a youth in "Friday"; sign out days later — the record must attach to the campout, not to whatever is on the calendar at pickup time.
4. At a youth-only meeting, try checking an adult in → blocked with a clear message.

### 7. Offline (do this before the first campout)
1. Log in on a phone once on Wi-Fi (this caches the roster + session), then enable airplane mode.
2. Kill and reopen the installed PWA → it loads, shows your name, and warns it's offline.
3. Search, badge-scan, and sign youths in/out — each shows "Saved offline", and the ⏳ pill counts up.
4. Restore connectivity → within ~20 s the pill clears and Admin → Transactions shows the records.
5. Race check: while offline, sign someone in who was *already* signed in at another station → after reconnect the ⚠ pill appears; tapping it explains and clears.

### 8. SMS (after Twilio setup — see README "SMS setup")
1. Put your own mobile as a guardian's number on a test youth; sign them into an event whose end time has passed (set "SMS reminder delay" to 0 in the event editor to skip the wait).
2. Within 5 minutes you get one text. Verify no duplicate on the next sweep.
3. Reply **Y** → confirmation text; kiosk on-site list drops the youth; Admin → Transactions shows an OUT with `sms_confirm`; Reports → notification log shows `replied_y`.
4. Reply **STOP** → log shows future sweeps skip that guardian; **START** re-enables.

### 9. Reports & retention
1. Admin → Reports: leave filters empty → Run summary → every attendee with events/sign-in counts and first/last seen.
2. Narrow to one event, one person, and a date range; download both CSVs and open them in Excel.
3. Spot-check: the numbers must ignore voided transactions.

### 10. Corrections & audit
1. Void a sign-out → youth pops back onto the on-site list; void the sign-in → gone again; both marker records visible.
2. Dashboard → Admin close on a lingering youth → recorded as `admin_close` under your name.
3. Overrides CSV lists every forced signature with staff and signer.

### 11. Backup & restore (do once now, not during a crisis)
1. Admin → Tools → Back up now → confirm files in `data/backups/`.
2. Stop the server; copy the snapshot over `data/troop.db` (delete `-wal`/`-shm`); untar signatures; start; verify history intact.

## When something fails

Reproduce with `npm test` if possible; server logs go to journald on the Pi (`journalctl -u troop-checkin -f`). File issues with: what you did, what you expected, what happened, and the relevant log lines. Never attach the real database or roster to an issue.
