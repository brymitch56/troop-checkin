# 13 — Integration API (read-only) and outbound webhook

**Status: implemented** (tc-v60) — `server/lib/integrationAuth.js`,
`server/routes/integration.js`, `server/lib/webhook.js`, migration
`014_webhook_delivery.sql`, admin tab **Integrations**. Off by default:
while the API is disabled or no key exists, every `/api/integration/*`
request answers `401`, and no webhook fires. Existing installs see no
behavior change after upgrading.

## Purpose

A separate program running next to the check-in app (typically on the same
box — a reporting dashboard, an advancement/badge tracker, a second troop
tool) needs to know **who was signed in to which event**. Until now the only
per-event attendance left the app as an admin CSV behind a browser session.
This layer adds machine-to-machine access with a deliberately small, generic
contract. Nothing in it is specific to any external product.

**PII stance (design goal, not an afterthought).** The API exposes stable
identifiers (`member_id`, `tlc_user_id`, the app's `person.id`; `ical_uid` +
`start_at` for events), names, level/patrol, membership status and sign-in
/ sign-out times. It never exposes guardians, phone numbers, emails,
addresses, birthdates, emergency contacts, signatures, photos, health or
consent data, badge codes, or event descriptions. Webhook payloads carry
identifiers only — no names at all. The tests assert the absence of these
fields, not just the presence of the intended ones.

## Enabling (Admin → Integrations)

1. **Generate key.** The plaintext key (`tci_…`, 256 bits) is shown once;
   the app stores only an scrypt hash (same primitive as staff PINs). Copy
   it into the consumer. The status line keeps an 8-character hint so keys
   can be told apart.
2. **Enable the Integration API.** Refused until a key exists.
3. Optional **webhook**: URL + signing secret (write-only; encrypted at rest
   with the same `CRED_KEY` that protects the TLC password) → pick event
   types → Save → **Send test event** → **Send webhook deliveries**.

**Generate new key** replaces the key immediately; **Revoke key** removes it
(the API stays enabled but answers 401). Failed authentication attempts are
counted (count + last-seen, no key material) and reset on a new key.

One key per instance. Separate instances (one per troop) each have their
own key and their own webhook.

## Authentication

```
Authorization: Bearer tci_…
```

Bearer only. Session cookies are not accepted on these routes, and the key
is not accepted anywhere else. Any failure — disabled, no key, missing
header, wrong key — answers the same body:

```
401 { "error": "invalid api key" }
```

Like every `/api/*` route, these answer `503` until the first-run setup
wizard has completed. No CORS headers are sent: the routes are
server-to-server, browsers never call them directly.

## Endpoints

All JSON. Timestamps are ISO-8601 UTC as stored (`2026-09-14T23:00:00.000Z`).
Boolean-ish columns are `0`/`1`.

### `GET /api/integration/ping`

Health check / "Test connection".

```json
{ "ok": true, "app": "troop-checkin", "version": "0.4.35",
  "troop_id": "NY-0000", "theme": "traillife",
  "tz": "America/New_York", "now": "2026-09-14T22:58:11.204Z" }
```

### `GET /api/integration/events?from=YYYY-MM-DD&to=YYYY-MM-DD`

Events whose **local** start date falls in `[from, to]`. Default window: 30
days back to 60 days ahead. Manual events (`source = "manual"`, `ical_uid`
null) and events that disappeared from the feed (`removed_from_feed = 1`)
are included — the consumer decides what to plan against. **Capped at 500
rows** (ordered by start); narrow the window if you hit it. `400` on a
malformed date.

```json
[{ "id": 42, "ical_uid": "<feed uid>", "tlc_event_id": "<eventHashid>",
   "source": "ical", "title": "Weekly Meeting", "location": "Church hall",
   "start_at": "2026-09-14T23:00:00.000Z", "end_at": "2026-09-15T00:30:00.000Z",
   "all_day": 0, "track_adults": 0, "removed_from_feed": 0,
   "requires_permission_form": 0 }]
```

Shared event identity between systems is `ical_uid` + `start_at` — the same
`UNIQUE (ical_uid, start_at)` the app's schema uses — because both systems
ingest the same iCal feed. `tlc_event_id` is the TLC hashid when known.

### `GET /api/integration/events/:id/attendance`
### `GET /api/integration/attendance?ical_uid=…&start_at=…`

Presence at one event. The second form looks the event up by shared
identity; `start_at` is normalized through `Date` so `…T23:00:00Z` and
`…T23:00:00.000Z` both match. `404` when no event matches.

```json
{ "event": { "id": 42, "ical_uid": "<feed uid>", "tlc_event_id": "<eventHashid>",
             "title": "Weekly Meeting", "start_at": "…", "end_at": "…", "track_adults": 0 },
  "generated_at": "2026-09-15T01:02:03.000Z",
  "attendance": [
    { "person_id": 17, "member_id": "<memberId>", "tlc_user_id": "<userHashid>",
      "last_name": "Andrews", "first_name": "Ben", "nickname": null,
      "is_youth": 1, "level": "Navigators", "patrol": "Falcons", "status": "active",
      "signed_in_at": "2026-09-14T23:02:10.000Z", "signed_out_at": "2026-09-15T00:31:40.000Z",
      "open": 0, "forced": 0, "permission_override": 0,
      "sign_in_txn_id": 9001, "sign_out_txn_id": 9017 }
  ] }
```

Derivation rules (all enforced by tests):

- Built from `txn` + `txn_person`. **Voided transactions are ignored**
  (`voided_by_txn_id` set), and so are the void marker rows themselves.
- **One row per person**: the earliest non-voided sign-in and the sign-out
  that closed it, if any. `open = 1` means still signed in (no sign-out
  yet); the consumer decides whether "present" requires a sign-out.
- **Adults appear only when the event tracks adults** (`track_adults = 1`).
- **Visitors are included** with `status: "visitor"` (and typically a null
  `member_id`) so the consumer can hold or ignore them. A person who was
  later deactivated keeps their history and shows `status: "inactive"`.
- **Merged records resolve** to the surviving person; a merged id never
  appears.
- `forced` = staff overrode the signer check; `permission_override` = staff
  overrode a permission-form block. Both are informational.

Person identity for matching: `member_id` first, `tlc_user_id` second,
`person_id` as a tie-breaker (stable within one instance).

### `GET /api/integration/people`

Active and visitor people, youth and registered adults, for matching
identities before any attendance exists. Inactive and merged records are
excluded. **Capped at 2,000 rows.**

```json
[{ "id": 17, "member_id": "<memberId>", "tlc_user_id": "<userHashid>",
   "last_name": "Andrews", "first_name": "Ben", "nickname": null,
   "is_youth": 1, "level": "Navigators", "patrol": "Falcons",
   "status": "active", "membership_expires": "2027-06-30" }]
```

## Outbound webhook

When enabled, the app POSTs a signed JSON payload to the configured URL:

| `type`        | When                                                             |
|---------------|------------------------------------------------------------------|
| `txn.created` | after ANY transaction commits: kiosk sign-in/out, admin close, SMS pickup confirm — including offline transactions replayed later (they carry their original `signed_at`) |
| `txn.voided`  | after an admin voids a transaction                               |
| `ical.synced` | after each calendar sync (counts only)                           |
| `test`        | the admin's **Send test event** button (one shot, never retried) |

Payloads:

```json
{ "type": "txn.created", "sent_at": "2026-09-14T23:02:10.400Z",
  "instance": { "troop_id": "NY-0000", "theme": "traillife" },
  "txn": { "id": 9001, "client_uuid": "…", "event_id": 42, "ical_uid": "<feed uid>",
           "start_at": "2026-09-14T23:00:00.000Z", "direction": "in",
           "signed_at": "2026-09-14T23:02:10.000Z", "forced": 0, "voided_by_txn_id": null },
  "persons": [{ "person_id": 17, "member_id": "<memberId>", "tlc_user_id": "<userHashid>", "is_youth": 1 }] }
```

`txn.voided` is the same shape plus `voided_txn_id` and `voiding_txn_id`
(and `txn.voided_by_txn_id` set). `ical.synced` carries
`counts: { added, updated, flagged, deleted, feed_events }`. `test` carries
only `type`, `sent_at`, `instance`.

Headers on every delivery:

```
Content-Type: application/json
X-Troop-Checkin-Event: txn.created
X-Troop-Checkin-Timestamp: 1789513330          (unix seconds)
X-Troop-Checkin-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>
User-Agent: troop-checkin-webhook
```

**Verifying (Node, the reference the app's own tests use):**

```js
const crypto = require('crypto');
function verify(secret, headers, rawBody, now = Math.floor(Date.now() / 1000)) {
  const ts = headers['x-troop-checkin-timestamp'];
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > 300) return false; // 5-minute window
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const got = String(headers['x-troop-checkin-signature'] || '');
  return expected.length === got.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}
```

Sign over the **raw request body bytes** (not a re-serialized object).
Answer any `2xx` promptly — do the real work after responding.

**Delivery semantics.** Rows are queued in `webhook_delivery` after the
SQLite commit and sent by a background sweep (immediately on enqueue, then
every minute). Failures retry with backoff — 1 min, 5 min, 30 min, then
2-hour steps — for about 24 hours (14 attempts), then the row is marked
`failed` and shows in the admin tab, where **Retry failed** starts the
ladder again. Deliveries are sequential and single-flight. A slow or
unreachable consumer never blocks or fails the sign-in path (the enqueue is
one local INSERT wrapped in try/catch). Consumers should treat deliveries as
**at-least-once** and de-duplicate on `txn.id` (a retry after a lost `2xx`
re-sends the same payload). Sent rows are pruned after `TLC_RETAIN_DAYS`
(default 30 days); pending/failed rows are kept until they resolve.

The signing secret is stored AES-256-GCM-encrypted with `CRED_KEY` (auto-
generated into `.env` on first save — see `lib/credCrypto.js`). If that key
is lost, deliveries fail with "Signing secret unreadable" until the secret
is re-entered.

## Non-goals

- No write endpoints; the consumer never modifies people, events or
  transactions.
- No CORS, no per-key scopes, no multiple keys.
- Nothing badge-, advancement- or organization-specific in this repo.

## Operational notes

- Same-host consumers can use `http://127.0.0.1:<port>/…` for both the API
  base URL and the webhook target; the app accepts plain `http` for the
  webhook URL for that reason. Anything crossing the internet should be
  `https`.
- `curl -H "Authorization: Bearer <key>" http://localhost:3000/api/integration/ping`
  is the quickest smoke test on the box.
- The admin tab's status block shows: key hint and creation time, last
  successful call, failed-auth count, webhook queue counts and the last
  delivery, plus the 30 most recent deliveries with attempts and errors.
