# 05 — Implementation Reference

As built, 2026-07-19. Companion to the planning docs (01–04); where they disagree, this file describes what the code actually does.

## Stack and layout

Node 20 LTS + Express 4 + better-sqlite3 (WAL mode) on a Raspberry Pi; vanilla-JS PWA clients. Dependencies are deliberately few and arm64-safe: `better-sqlite3`, `express`, `multer` (2.x), `node-ical`, `xlsx`. Twilio is called over plain REST (no SDK).

```
server/
  index.js            app assembly, static serving, session-gated /signatures + /photos,
                      /api/config + dynamic manifest, nightly schedulers (exports app; listens
                      only when run directly)
  auth.js             scrypt credential hashing, DB-backed sessions (door 6h / admin 2h),
                      cookie handling (Secure flag when req.secure), requireAuth middleware
  db.js               opens $DATA_DIR/troop.db, creates data dirs
  migrate.js          applies server/migrations/*.sql in order, tracked in schema_migration
  migrations/         001_init (full schema) · 002 (txn.forced) · 003 (person.manual_fields, photo_path)
                      · 004 (consent_form, pg.consent_form_id) · 005 (notification.kind) · 006 (sms_message)
                      · 007 (person.membership_expires) · 008 (pending_import)
  lib/
    env.js            zero-dep .env loader; live getters (PORT, TROOP_*, ICAL_URL, SMS/Twilio, PUBLIC_URL)
    rosterImport.js   TLC xlsx parser, guardian-link suggestion, preview/apply, field locks
    membership.js     expiration-date normalization (ISO), day-granular daysUntil, expiring list
    selfcheck.js      fail-fast boot check: core modules must export what callers destructure,
                      else exit(1) before listen (a 0-byte module must never boot "healthy")
    rosterSync.js     pending-import staging/approve/discard for the automated TLC fetch
                      (same parse/preview/apply functions as the manual import route)
    icalSync.js       feed sync, removed-from-feed rule, nightly scheduler
    backup.js         VACUUM INTO + signatures tar, nightly 03:15, keep 14
    sms.js            Twilio REST send, E.164/last-10 normalization, X-Twilio-Signature HMAC check
    notifySweep.js    lingering-youth sweep -> SMS, 5-min scheduler (only when SMS_ENABLED)
  routes/
    api.js            kiosk API (door session)
    admin.js          admin API (admin session)
    sms.js            Twilio inbound webhook (signature auth, no session)
  scripts/
    create-staff.js   CLI: name + door|admin + PIN/password
    make-synthetic-roster.js  fake-family TLC-format xlsx for tests
    fetch-roster.js   TLC roster fetcher (Yii2 login, 503-kickoff + poll, byte
                      sniffing, row-count guard) — stages a pending import; CLI
                      + exported units for tests; weekly systemd timer
public/
  index.html/app.js/styles.css   kiosk PWA
  admin.html/admin.js/admin.css  admin SPA
  offline.js          IndexedDB snapshot + txn queue + conflict store
  guide.html          in-app user guide (kiosk + admin, print CSS; troop-generic,
                      brand injected from /api/config; in the SW shell so it works offline)
  sw.js               app-shell cache (VERSION tc-v13 — bump when public/ changes)
  vendor/jsqr.min.js  vendored QR decoder (camera fallback path)
scripts/
  install-pi.sh       fresh clone -> Node 20 -> npm ci -> migrate -> systemd
  deploy-verify.sh    post-deploy integrity guard (tree==HEAD, no 0-byte files, module
                      exports, migrations reconciled, service/healthz/sw) -> RESULT: PASS/FAIL
  troop-checkin.service.template
.github/workflows/ci.yml   required node:test gate on push/PR to main + advisory browser-E2E job
test/                 97 node:test cases (9 files) + e2e-browser.js (puppeteer, 21 steps)
```

## Data model highlights

Schema is in `server/migrations/001_init.sql` (see doc 03). Later additions: `txn.forced` (staff override audit), `person.manual_fields` (JSON array of import-locked columns), `person.photo_path`. Nothing is ever deleted: people become `inactive` or `merged` (with `merged_into_id`), transactions are append-only (`voided_by_txn_id` points at the correcting record), and every roster upload is archived on disk and logged in `roster_import`. SQLite handles many years of a troop's data trivially; date filtering normalizes both stored timestamp formats via `datetime()`.

## Behavior notes (the non-obvious ones)

**Sessions & auth.** Staff pick their name and enter a PIN (door) or password (admin). Secrets are scrypt-hashed. Sessions live in the DB; cookies are HttpOnly/SameSite=Lax, plus Secure over HTTPS. All kiosk routes need a door session; `/api/admin/*` needs admin; the SMS webhook authenticates with Twilio's signature instead.

**Transactions (`POST /api/txn`).** Client sends `client_uuid` (dedupe key — retries and offline sync are idempotent), direction, entries, signer, signature dataURL. Server-side validation is authoritative: open-state race checks (409), event required for IN, adults rejected at non-tracking events (422 FR-12), signer authorization per youth (422 unless `force`, which is recorded in `txn.forced`). Sign-out needs no event: it attaches through the open sign-in's event (multi-day events work by construction). Emergency phones snapshot onto the txn row and write back to the person as next-time defaults.

**Roster import.** Parser finds the header row by the "Member Number" cell; Youth Y/N discriminates; youth "Email" is a TLC username, not an email. Matching keys on member number (falling back to name only for unregistered adults). Absent people are deactivated only within the classes present in the file, never visitors. Guardian suggestions: cc-email → adult email, else same last name or same address+zip; existing links are never touched or duplicated. **Field locks:** any import-managed field changed through the admin editor lands in `person.manual_fields` and every future import skips it for that person ("Save" locks; per-person unlock button clears).

**Deploy integrity (hardening after the 2026-07-26 incident).** A `git pull` once landed `membership.js` as 0 bytes on the Pi; `require()` of an empty file succeeds, so the service booted "healthy" and would only have crashed when roster import called the missing function. Three layers now guard this class of failure: (1) `server/lib/selfcheck.js` runs before `app.listen` when the server is started directly — it typeof-checks the critical exports (`membership`, `rosterImport` incl. non-empty `UPDATABLE`, `sms`, `notifySweep`) and exits 1 with `STARTUP SELF-CHECK FAILED: …` so systemd restarts loudly instead of serving a time bomb; (2) `scripts/deploy-verify.sh` (mirrors the on-Pi `~/troop-deploy-verify.sh`) is run after every deploy and fails on a dirty tree, zero-byte tracked sources, missing exports (it reuses `selfcheck.runSelfCheck`, so the lists can't drift), pending migrations, or unhealthy service/sw/DerbyNet; (3) GitHub Actions CI runs the full node:test suite (required) plus an advisory browser-E2E job on every push/PR to main. Tests cover the self-check against real modules, stubs, and a real boot of a truncated copy.

**Automated roster sync (docs/10-roster-sync.md).** `server/scripts/fetch-roster.js` reproduces the observed TLC flow: Yii2 CSRF login (one attempt, never retried — account-lock safety), export GET that 503s to kick off a server-side job, an XHR poll until `finished`, then the file. Content-Type is never trusted (TLC mislabels CSV as spreadsheetml) — bytes are sniffed (`PK` zip magic = xlsx, doctype/html = error page, else CSV). Sanity gates: ≥512 bytes, "Member Number" header present (same locator rule as the importer), ≥5 data rows, and a **row-count guard** vs the last successful fetch (`TLC_ROW_TOLERANCE`, default 20% — a stale TLC filter returning a partial roster must never mass-deactivate members). Success stages a **pending import** (migration 008, one at a time, newer replaces older) via the same parseWorkbook/computePreview as the manual route; Approve in Admin → Import re-runs the full apply path attributed to the approving admin, Discard drops it. The job **never commits**. State (`data/roster-fetch-state.json`) records last run/status/error for the UI; downloads land in `data/roster-exports/` mode 600, pruned after `TLC_RETAIN_DAYS` (56). Scheduling: `troop-roster-sync.{service,timer}` templates (weekly Sun 03:30, `Persistent=true`, `MemoryMax=256M`, separate unit from the app), installed optionally via `install-pi.sh --with-roster-sync`; "Sync now" spawns the same script as a child process. Kill switch `TLC_ENABLED=false`; credentials only ever live in `.env`.

**Membership expiration.** The TLC export's "Membership Exp." column (trailing period; header row found by "Member Number") imports into `person.membership_expires` — normalized to ISO `YYYY-MM-DD` when the formatted cell string is recognizable (US M/D/YYYY, ISO, or Date-parseable), stored raw otherwise; all compare-time code parses defensively and treats junk as "no date". It is in the parser's `UPDATABLE` list, so hand edits lock it against imports like any import field. Kiosk: a youth expiring within 30 days (day-granular, expired included) gets an orange `.exp-tag` on their cart row and a "Membership expires MMM D — renewal due" line in the sign modal — **never blocks check-in**, and works offline because `membership_expires` rides in the roster snapshot (`personView`). Admin: Reports → "Membership renewals" (30/60/90-day window incl. registered adults, most-lapsed first) + `expiring.csv`, and a dashboard "renewals due ≤30 days" card (`status.expiring_30`).

**Authorized adults.** `person_guardian` rows carry `authorized`, `is_primary`, `relationship`, `source` (`import_email`/`import_address`/`manual`), `sms_opt_in`. Admin edits flip `source` to `manual` and are permanent against imports. Import-created links cannot be deleted (they would resurrect on re-import) — they get unauthorized instead. Consent-form designees are created as brand-new adults (no member number, any name) and linked in one step; they appear in the kiosk signer picker like any guardian.

**iCal sync.** Nightly + on-demand. Events are discrete (no RRULE by design). An ical event that vanishes from the feed is deleted if it has no transactions, kept and flagged `removed_from_feed` if it has any; returning to the feed clears the flag.

**Offline (kiosk).** `offline.js` keeps an IndexedDB snapshot (people incl. open-state and badges, guardian links, event window) refreshed at login and after every transaction. Every kiosk lookup falls back to the snapshot when fetch fails at the network level (HTTP errors do not trigger fallback). Transactions queue in order and flush on reconnect/interval; server rejections (409/422/400) move to a conflicts store surfaced via the ⚠ pill — the server is authoritative, the human clears the pill. Sessions restore from a cached identity when offline. The service worker only guarantees the shell loads; `/api` is intentionally network-only.

**SMS.** Sweep runs every 5 min (only when `SMS_ENABLED=true`): youth still open past `event.end_at + notify_after_min` (default 30) → one text to the primary authorized, non-stopped guardian, once per youth/guardian/event, logged in `notification`. Inbound webhook validates `X-Twilio-Signature` against `PUBLIC_URL`; `Y` closes the notified youth's sign-ins (`close_method='sms_confirm'`, guardian recorded as signer), `STOP`/`START` maintain `sms_opt_in`. Without Twilio credentials the sweep records `failed` rows and sends nothing.

**Corrections.** Void inserts a reversing marker txn and links it via `voided_by_txn_id`: voiding an IN closes its open rows; voiding an OUT reopens the original sign-in (unless that is itself voided). Admin close-open writes an `admin_close` OUT. Both are attributed to the acting admin.

## API surface

Kiosk (door session): `GET /api/staff-list*`, `POST /api/login*`, `POST /api/logout`, `GET /api/me`, `GET /api/search`, `GET /api/badge/:code`, `POST /api/badge/link`, `GET /api/person/:id/guardians`, `POST /api/visitor`, `GET /api/events/current`, `POST /api/events`, `POST /api/txn`, `GET /api/onsite`, `GET /api/patrols`, `GET /api/roster-snapshot`, `POST /api/roster/import` (admin), `GET /api/config*`, `GET /healthz*` (* = no session).

Admin: `GET/PATCH /api/admin/people[/:id]`, `POST/DELETE /api/admin/people/:id/photo`, `POST /api/admin/people/:yid/guardians[/new]`, `PATCH/DELETE /api/admin/people/:yid/guardians/:gid`, `GET/PATCH/DELETE /api/admin/events[/:id]`, `POST /api/admin/sync-ical`, `GET /api/admin/txns[/:id]`, `POST /api/admin/txns/:id/void`, `POST /api/admin/close-open`, `POST /api/admin/merge`, `GET /api/admin/imports`, `GET /api/admin/notifications`, `GET /api/admin/report/summary`, `GET /api/admin/expiring` (`days` = 30/60/90…), `GET/POST /api/admin/roster-sync[/run|/approve|/discard]`, `GET /api/admin/export/{attendance,summary,open,overrides,visitors,expiring}.csv`, `POST /api/admin/backup`, `GET /api/admin/status`. Report/export filters: `from`, `to` (dates, inclusive), `event_id`, `person_id`.

Webhook: `POST /api/sms/inbound` (Twilio signature).

## Configuration (.env)

`PORT`, `DATA_DIR`, `DB_PATH`, `TROOP_ID`, `TROOP_NAME` (drive all branding — nothing troop-specific in source), `ICAL_URL`, `SMS_ENABLED`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `PUBLIC_URL`. See `.env.example` for documentation of each.

## Known deferred items

Staff management still uses the CLI (`npm run create-staff`). Web push to on-duty leaders, guest-troop groupings, and cart handoff between devices remain backlog (doc 04 Phase 5). Cloudflare Tunnel/Access, rclone backup push, and A2P registration are operational steps done outside the repo.
