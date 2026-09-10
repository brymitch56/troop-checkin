# Troop Check-In App — Automated Roster Sync

Draft v0.1 · Phase 2 addition · Trail Life Troop NY-2911

## Purpose

Replace the manual "download the member export from Trail Life Connect, then upload it in the admin UI" loop with a scheduled job on the Pi that fetches the export automatically. The human stays in the loop for the **commit** decision — the job only ever produces a preview.

Motivating constraint: the troopmaster's laptop is shared and frequently powered off, so nothing may depend on a desktop being awake. The Pi is the only reliable always-on machine, which rules out browser-based automation (Claude in Chrome, Playwright) both on availability grounds and on RAM grounds for a 3B+.

## Findings — how the TLC export actually works

Established by network inspection of a signed-in session (July 2026). These are observed facts, not assumptions; if the implementation disagrees with them, re-verify before changing the design.

The export is a plain server-rendered link, not an AJAX call, and not a client-side blob. **No browser is required.** The sequence:

| Step | Request | Notes |
|---|---|---|
| 1 | `GET /login` | Yii2 form; yields `_csrf` cookie + token |
| 2 | `POST /login` | fields `LoginForm[email]`, `LoginForm[password]`, `LoginForm[rememberMe]`, `_csrf` |
| 3 | `GET /user/index?export=xlsx&new=0` | returns **503** — kicks off an async server-side job |
| 4 | `POST /databuilder/get-download-status` | no body; headers `X-CSRF-Token`, `X-Requested-With: XMLHttpRequest`, `Accept`. Returns `{"status":"pending"}` then `{"status":"finished"}` |
| 5 | `GET /user/index?export=xlsx&new=0` | same URL, now **200**, returns the file |

Additional details:

- Auth on the file GET is the **session cookie alone** — no CSRF token, no `Authorization` header. The session cookie is HttpOnly (good) so it must come from a real login, not from copying a browser cookie.
- The CSRF token is an 88-char base64-ish value, rendered in the page's `<meta name="csrf-token">`.
- `export=csv` and `export=xlsx` use the identical mechanism, including the same polling endpoint. Only the parameter value differs.
- **The server mislabels the CSV response** as `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Never trust the content type — sniff the bytes. A real xlsx begins `50 4b 03 04` (`PK`, a zip signature); the CSV begins with plain text.
- **Use the xlsx export.** It matches the format the import parser was built and validated against (FR-10), so nothing downstream changes.
- ~~No MFA or CAPTCHA on the login form as of this writing.~~ **MFA arrived, 2026-09-10** — see "Second factor" below. Unattended *password* login is over; unattended *syncing* is not.
- **Multi-role accounts (found in live use, 2026-07-26):** TLC signs a session in under the account's **last-used role**, and the export requires a role with member-list access (e.g. Troopmaster). There is no verified way to detect or switch the active role over HTTP, so the fetcher can't check it — instead, every sanity-check failure message names the wrong-role possibility, and the admin credentials panel carries a standing warning. Mitigations: switch the account to the permitted role in a browser before relying on the sync, or use a dedicated single-role account. If the role marker / role-switch request is ever captured from DevTools (like the findings above), automated detection can be added.
- The `new=0` parameter's meaning is unconfirmed. Verify it does not mean "changes since last export."

### Open question — export filtering — **RESOLVED SAFE (2026-07-26)**

**Resolution:** the live Pi test (2026-07-26) ran the full fetch in a fresh session and received the complete 113-row roster with zero deactivations in the preview — a fresh login does **not** inherit filter state, so automated sync is safe on this front. The row-count guard stays enabled as standing defense anyway. Original concern preserved below for the record.

The xlsx button's tooltip reads **"Export filtered to Excel"**, and a test export returned only the members matching a filter that had been applied earlier in the session. It is not yet known whether that filter state persists across logins.

**This must be resolved before the job is scheduled.** If a stale server-side filter can survive into a fresh session, an automated fetch could silently return a partial roster, and a committed import would mass-deactivate everyone missing from it.

Resolution procedure: clear all filters in TLC, log out, log in fresh, fetch, and compare the row count to the full roster. If filter state does persist, the fetcher must explicitly reset the member view before requesting the export, and the row-count tolerance below must be tightened.

## Design

A standalone Node script, `server/scripts/fetch-roster.js`, with **no new dependencies** — Node 20 global `fetch`, a hand-rolled cookie jar, and the existing `xlsx` package for validation. Everything must stay arm64-safe and installable on a Pi 3B+ from a fresh clone.

A working starting implementation exists and should be reviewed, corrected, and tested rather than rewritten from scratch. It has never been run against the live site.

### Configuration (`.env`, documented in `.env.example`)

| Variable | Purpose |
|---|---|
| `TLC_EMAIL` / `TLC_PASSWORD` | login credentials |
| `TLC_BASE` | defaults to `https://www.traillifeconnect.com` |
| `TLC_EXPORT_PATH` | defaults to `/user/index?export=xlsx&new=0` (TLC). Sibling portals on the same platform need their own: AHGfamily is `/user/exportexcel?format=xlsx` (the TLC path returns HTML there). The importer maps that portal's `Squad` → patrol and `Health Form On File` → health-form date (Yes/No cells are ignored) |
| `TLC_ENABLED` | kill switch; `false` makes the job a no-op |
| `TLC_LOGIN_PATH` | login form path, also used to probe whether a stored session is still signed in (`TLC_PROBE_PATH` overrides the probe alone) |
| `TLC_MFA_FIELD` / `TLC_MFA_PATH` | escape hatches for the second-factor form: pin the code input's name / where to post it. Empty by default — the form is normally found by shape |
| `HEALTHCHECK_URL` | optional success ping (healthchecks.io) |

Credentials live in `.env` (`chmod 600`, owned by the service user, gitignored) **or** — since the 2026-07-26 addition — can be entered/updated by an admin in Admin → Import → "Trail Life Connect credentials": stored in the app database (`meta` table), write-only toward the browser (never returned by any API), and taking precedence over `.env` when present. Either way they must never appear in logs, error messages, commit history, or test fixtures.

**Encrypted at rest (added 2026-07-30):** the admin-saved password is stored AES-256-GCM-encrypted (`server/lib/credCrypto.js`). The key (`CRED_KEY`, 64 hex chars) is auto-generated on the first save and appended to `.env` — deliberately *outside* `data/`, so DB snapshots and the nightly local backups contain only ciphertext; recovering the password requires both the DB and `.env`. Rows saved before this change (plaintext) are transparently re-encrypted the first time they're read. If `CRED_KEY` is lost or changed, nothing crashes: `getTlcCredentials()` returns null (fetch falls back to `.env` creds or fails at config), and the admin panel shows a "can no longer be decrypted — re-enter the password" warning (`credentialInfo().readable === false`). GCM authentication also means a tampered ciphertext reads as unreadable rather than as a wrong password quietly sent to TLC.

**Env loading (fixed 2026-07-26):** `fetch-roster.js` self-loads `.env` via `require('../lib/env')` — the same parser the app uses — so the standalone CLI and the systemd timer see credentials without any preload. The systemd unit also sets `EnvironmentFile=-.env` as defense-in-depth; note systemd's parser is not a shell parser and its values win over env.js's (env.js never overrides existing process.env), so keep `.env` values simple or prefer the admin-saved credentials.

### Second factor (added 2026-09-10, tc-v66)

The portal now enforces MFA at account level. On the `/user/mfa-setup` page the
two offered factors read:

- **Passkey** — *"Replaces your password entirely"*, and *"can only be added
  from a mobile device"*. **Do not enable this on the sync account**: it takes
  the password out of the flow, and the password is what a headless client has.
- **Text message code** — *"You'll enter your password and a code sent to your
  phone number at every sign-in."* This is the one to use. There is no
  trusted-device or "remember this browser" option; the page says *every*
  sign-in and means it.

So a password POST no longer returns a session — it returns a code form. That
breaks *every* portal consumer at once, because they all sign in through
`fetch-roster.js login()`: the weekly roster fetch, the attendance write-back
sweep (docs/12), and the permission-form sync.

**The design is connect once, machine continues** (`server/lib/portalSession.js`):

| | |
|---|---|
| 1 | A human presses **Connect** in Admin → Import (or a job runs, finds no usable session, and parks a prompt for the next human). |
| 2 | The server posts the password. The portal answers with a code form; that form and the half-authenticated cookie jar are parked, encrypted, for 15 minutes. |
| 3 | The human types the code off their phone. The server posts it and keeps the resulting cookie jar. |
| 4 | Every later sign-in restores that jar and probes `GET $TLC_LOGIN_PATH` — a live session is redirected away from the form, a dead one gets the form back. Live → no password, no code. Dead → back to step 1. |

Notes that matter:

- **The code form is found by shape, not by name.** `parseChallenge()` looks for
  a `<form>` with no password input and one short free-text input whose name
  looks like a code field, and carries every hidden input (Yii's `_csrf`
  included) back verbatim. The two sibling portals name things differently and
  either can change; `TLC_MFA_FIELD` / `TLC_MFA_PATH` pin the field name and
  post target if a redesign ever outruns the detector.
- **Nothing retries.** Each password POST costs the admin a text message, so a
  parked prompt latches the attendance sweep (`code_required_at`) exactly the
  way a rejected password latches it, and only a human clears it. A *rejected
  code* re-parks the refreshed form instead, so retyping a digit never costs a
  new message.
- **Session cookies and the parked prompt are encrypted at rest** with the same
  `CRED_KEY` that protects the password — backups and DB snapshots hold only
  ciphertext. A missing or rotated key degrades to "not connected", never to a
  crash: worst case is one more sign-in.
- **No automatic code retrieval was built, on purpose.** A mail/SMS relay that
  reads the code and types it back would put both factors in the same machine —
  single-factor auth, on an account that reaches youth records, dressed as two.
  A human typing six digits once per session lifetime *is* the second factor.
  (If the portal ever offers API tokens or a trusted-device option, that is the
  right thing to adopt instead — the request drafted for TLC support asks for
  exactly that, on the precedent that `ICAL_URL` is already a tokenized,
  unauthenticated feed.)
- **Unknown, to be measured in use:** how long a portal session survives. That
  number is the whole cost of the scheme — it is how often somebody has to be
  standing there with a phone. The admin panel shows "signed in <when>, last
  used <when>", which is the measurement.

### Safety rules (non-negotiable)

1. **The job never commits.** It downloads, validates, and hands the file to `/api/roster/import?mode=preview`. A pending import appears in the admin UI for one-tap approval.
2. **A failed login exits immediately.** No retry loop — repeated failures risk locking the TLC account. The same rule covers the second factor: a code prompt exits with code 6 and waits for a human, because every attempt texts the admin another message.
3. **Validate before importing.** Reject: files under 512 bytes; anything beginning with `<!doctype`/`<html>` (an expired session returns a login page); a file with no "Member Number" header row; fewer than 5 data rows.
4. **Row-count guard.** Compare against the previous successful fetch, stored in `data/roster-fetch-state.json`. Abort if the count drops more than 20% (tighten if the filter question above resolves badly). Rationale: the realistic failure mode isn't a crash — it's a partial export parsing cleanly and deactivating the roster the night before a campout.
5. **Downloaded files are PII.** Write to `data/roster-exports/` with mode `600`. That directory must be gitignored. Retain a reasonable window (e.g. 8 weeks) and prune older files.

### Scheduling

A **systemd timer**, not cron — better logging via journald, and `Persistent=true` so a run missed while the Pi was off fires on next boot.

Run as a separate unit from the app service, with `MemoryMax` set, so a runaway fetch can never take down the check-in server sharing the box. Weekly is the target cadence; the unit and timer ship as templates alongside the existing `install-pi.sh`.

## Exit test

From a fresh clone on a Pi (or an arm64 sandbox): `npm ci` → migrate → start → `node server/scripts/fetch-roster.js` completes, logs a plausible row count, and writes an xlsx to `data/roster-exports/`. The resulting file, fed to the import preview, produces a diff with **zero unexpected deactivations**. Deliberately corrupt the saved file and confirm the validator rejects it rather than passing it through. Confirm the systemd timer fires and that `TLC_ENABLED=false` cleanly no-ops.

## Shareability

Nothing troop-specific may be hardcoded — the TLC base URL, export path, and credentials are all config. Another troop's admin should be able to set five environment variables and have this work. Document the whole feature in the README for a stranger troopmaster: what it does, what it deliberately does *not* do (auto-commit), and how to turn it off.

## Out of scope

Automating anything else on TLC. This feature reads one export and stops. No writes to TLC, ever.
