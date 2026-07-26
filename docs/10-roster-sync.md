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
- No MFA or CAPTCHA on the login form as of this writing. If TLC adds MFA, unattended login breaks and this feature must fall back to manual upload — design for that failure, don't fight it.
- The `new=0` parameter's meaning is unconfirmed. Verify it does not mean "changes since last export."

### Open question — export filtering

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
| `TLC_EXPORT_PATH` | defaults to the csv path; set to `/user/index?export=xlsx&new=0` |
| `TLC_ENABLED` | kill switch; `false` makes the job a no-op |
| `HEALTHCHECK_URL` | optional success ping (healthchecks.io) |

Credentials live only in `.env` — `chmod 600`, owned by the service user, already covered by `.gitignore`. They must never appear in logs, error messages, commit history, or test fixtures.

### Safety rules (non-negotiable)

1. **The job never commits.** It downloads, validates, and hands the file to `/api/roster/import?mode=preview`. A pending import appears in the admin UI for one-tap approval.
2. **A failed login exits immediately.** No retry loop — repeated failures risk locking the TLC account.
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
