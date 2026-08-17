# 12 — TLC Attendance Write-Back

**Status: implemented** — `lib/attendanceSync.js`, migration
`009_tlc_attendance.sql`, admin panel under Admin → Import, per-event
override in the event editor. Off by default; enable in Admin → Import.
Attendance is recorded at **sign-out** (kiosk sign-out, admin close, or SMS
pickup confirm — when the visit is over and participation is known). The
sign-out cart asks per youth "Completed all planned requirements for this
event" (default yes): checked → `use_lesson_plans=1` (advancement credit),
unchecked → `use_lesson_plans=0` (attendance only, this youth only). The
global advancement setting in Admin → Import is a master switch ANDed with
the per-youth answer.

**Same-name safety:** an operator can pin a person to one TLC profile by
setting their TLC user id in the person editor (with a roster-lookup helper
that reads one event's TLC list and offers same-surname candidates,
flagging ids already assigned elsewhere). A set id is authoritative: absent
from an event's roster means a visible `failed` row, never a fall-through
to a same-named relative. Name-match ambiguity (two identical names on one
TLC list) also fails explicitly. The People tab surfaces every same-name
group so these ids get set before they ever matter.
Event mapping needs no admin action: the TLC iCal feed UID embeds the event
hashid (`<16>-<hashid 12>-<15>`, verified against `/databuilder/search-events`
for events across 2024–2026), so every synced calendar event is born linked.
Advancement un-marking was verified manually on TLC (2026-08-11): removing
attendance also removes requirement checkmarks, so the app NEVER sends
`value=0` — undo stays a human action on the TLC site.

Observed TLC behaviour, captured live 2026-08-11 against the production Track
Attendance page (`/attendance`) while marking/unmarking a member on a test
event. Same Yii2 platform conventions as the roster fetch
(docs/10-roster-sync.md): `_csrf` cookie + token, session cookie from
`POST /login`, `X-CSRF-Token` + `X-Requested-With: XMLHttpRequest` headers on
every AJAX call.

## Goal

When a person checks in through the app, also mark them Attended on the
matching TLC event — which, when the event has activity plans attached and
`use_lesson_plans=1`, records advancement automatically on TLC's side.

## Captured endpoints

All requests are same-origin on `TLC_BASE` (default
`https://www.traillifeconnect.com`), sent with the session cookie jar.
AJAX headers on every call below:

```
X-CSRF-Token: <token from the csrf-token meta tag / login page>
X-Requested-With: XMLHttpRequest
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
```

### 1. Find the event

```
GET /databuilder/search-events?userId=<viewerHashid>&service=all&q=<partial name>
```

- select2 backing search for the "Select event" box; minimum 2-char query.
- `userId` = hashid of the **logged-in** account (the page embeds it in the
  select2 ajax URL server-side; obtain by loading `/attendance` and parsing,
  or test whether it can be omitted).
- `service=all` as observed.
- Response JSON: `{ "results": [{ "id": "<eventHashid>", "text": "Weekly
  Meeting - 08/10/2026", "start_date": ... }], "count": <n> }`
- Match on `text` (name + `MM/DD/YYYY`) and/or `start_date`.

### 2. Load the event roster / current attendance state

```
POST /calendar/attendance-user-list
body: patrol=&eventId=<eventHashid>&sortBy=<level|patrol|alphabetical>&rsvpOnly=0&lockAttended=1
```

- Returns an **HTML fragment** (~160 KB for a ~90-member troop), not JSON.
- Each member row: `div.user-row[data-user]` with a profile link
  `/profile/<userHashid>?tab=advancement`, followed by a Krajee checkbox-x
  widget whose hidden input is
  `id="<userHashid>-<eventHashid>-attended"` with `value` `1`/`0`/empty.
- This is the **name → userHashid mapping source** (the roster xlsx export
  does not contain hashids) and the read-back of current attendance state.
  Parse the fragment for `(<userHashid>, <eventHashid>, attended)` triples.

### 3. Mark / unmark attendance

```
POST /calendar/toggle-attendance
body: userId=<userHashid>&eventId=<eventHashid>&value=1&use_lesson_plans=1
```

- `value`: `1` = attended, `0` = not attended (verified both directions).
- `use_lesson_plans`: `1` when "Track advancement with event activity plans"
  is on — this is the flag that makes TLC record advancement for the event's
  attached activity plans. `0` = attendance only.
- Success: HTTP 200 with an **empty body**. Treat non-200 (or a login
  redirect) as failure; there is no JSON status to parse.
- Idempotent in practice: posting `value=1` twice leaves the member attended.

## Advancement caveat

Advancement only accrues when the TLC event has **activity plans attached**
("Activity plans covered during event" panel on `/attendance`). The test
event had none, so the advancement side-effect itself was not exercised —
only the flag that enables it. Before shipping, verify once against an event
with an activity plan that `use_lesson_plans=1` actually writes the expected
advancement records, and that `value=0` afterwards removes them.

## Other UI parameters (for completeness)

- `rsvpOnly` — "Show only users that have RSVP'd" filter on user-list.
- `lockAttended` — "Lock attended" UI preference; display behaviour only,
  passed to user-list.
- `sortBy` — `level` | `patrol` | `alphabetical` grouping of the fragment.

## Suggested app flow

1. Reuse the login flow + cookie jar + CSRF handling from
   `server/scripts/fetch-roster.js` (factor into a shared `lib/tlcClient.js`).
2. Admin maps an app event to a TLC event: search via `search-events`,
   store `tlc_event_id` (hashid) on the app event.
3. On first sync for an event, fetch `attendance-user-list`, parse the
   fragment, and cache `person → userHashid` (match by name, same
   normalisation as rosterImport) plus current attended state.
4. Push check-ins: `toggle-attendance` with `value=1` and the event-level
   `use_lesson_plans` setting (make it a per-event toggle in the admin UI,
   default from TLC's own checkbox semantics).
5. Queue + retry: cache failed pushes locally and batch-retry; never retry a
   failed **login** (account-lock risk — same non-negotiable as roster sync).
6. Read-back verification: re-fetch `attendance-user-list` after a push and
   confirm the input value flipped, since toggle returns an empty 200 either
   way.

## Safety rules (carry over from roster sync)

- Credentials via the existing encrypted store (`rosterSync.getTlcCredentials`).
- Failed login exits immediately, no retry loop.
- Never log credentials or tokens; attendance data is PII.
- Write-back should be **opt-in per event** and visible in the admin UI
  (what was pushed, when, for whom), with a kill switch like `TLC_ENABLED`.
