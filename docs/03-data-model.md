# Troop Check-In App — Data Model

Draft v0.2 · SQLite · (v0.2: `youth` generalized to `person` for adult attendance; emergency contact fields; import mapping)

## Entity Overview

```
person ──< person_guardian >── person (adult as guardian)
person ──< txn_person >── txn >── event
txn >── staff        txn >── person (signer, nullable)
notification >── person, event      roster_import (log)
```

## Tables

### person
One table for youth, adults, and visitors — attendance and history stay in one place.

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| is_youth | INTEGER | from the Youth (Y/N) column; visitors set at quick-add |
| member_id | TEXT UNIQUE NULL | e.g. `2021-381187`; NULL for parents/guardians, pending adults, visitors, unregistered adults |
| badge_code | TEXT UNIQUE NULL | full raw QR payload `<memberID> \| <token>`; linked on first confirmed scan |
| first_name / last_name / nickname | TEXT | |
| role | TEXT NULL | from Role column (Trailman, Parent/Guardian, Registered Adult, leader titles…) |
| patrol | TEXT NULL | youth patrols; adults carry "Parent Patrol" / "Leader/Registered Adult" as-is |
| level | TEXT NULL | Current Level (Fox, Hawk, Mountain Lion, Navigator, Adventurer…) |
| email | TEXT NULL | adults only — the youth "Email" column is a TLC **username** and is stored in `tlc_username` instead |
| tlc_username | TEXT NULL | youth Email column value |
| phone_mobile / phone_home / phone_work | TEXT NULL | E.164 normalized where possible |
| last_emerg_phone_1 / last_emerg_phone_2 | TEXT NULL | prefill defaults for FR-13 |
| status | TEXT | `active` / `inactive` / `visitor` / `merged` |
| notes | TEXT NULL | |
| created_at / updated_at | TEXT | ISO 8601 |

### person_guardian
Links a youth to the adults authorized to sign them out. Guardians are `person` rows (registered or not); visitors' guardians are quick-added adult rows.

| column | type | notes |
|---|---|---|
| youth_id / guardian_id | FK person | composite PK |
| relationship | TEXT NULL | |
| authorized | INTEGER | 1 = may sign out |
| is_primary | INTEGER | SMS notification recipient |
| source | TEXT | `import_email` / `import_address` / `manual` — import suggestions never overwrite `manual` rows |
| sms_opt_in | TEXT | `unknown` / `yes` / `stop` (honor STOP) — lives here or on person; per-guardian is sufficient at troop scale |

### staff
Unchanged from v0.1: id, name, role (`door`/`admin`), pin_hash/password_hash (argon2), active. Optionally seeded from Registered Adult rows but always explicitly created — roster import never creates logins.

### event
Unchanged from v0.1 (source `ical`/`manual`, ical_uid, title, location, start/end, all_day, notify_after_min), plus:

| column | type | notes |
|---|---|---|
| track_adults | INTEGER | per-event toggle: adult attendance on (FR-12) |
| removed_from_feed | INTEGER | set when an iCal event with existing transactions disappears from the feed — kept locally, never deleted |

### txn
As v0.1 (client_uuid dedupe, event_id, direction, signed_at/received_at, staff_id, signature_path, close_method, sms_sid, voided_by_txn_id, signer_name_override), with signer now `signer_person_id FK NULL`. Signature rules: required when the cart contains any youth; adult-only transactions have no signature (`close_method`/`signature_path` NULL, direction rows still logged).

### txn_person
| column | type | notes |
|---|---|---|
| txn_id / person_id | FK | composite PK — one signature covers all youth in the cart |
| open | INTEGER | 1 on an `in` row until matched by an `out` — the "who's still here" query, youth and adults alike |
| emerg_phone_1 / emerg_phone_2 | TEXT NULL | captured at every youth sign-in (all events, FR-13); also written back to person.last_emerg_phone_* |
| display_name | TEXT NULL | for unregistered adults recorded by typed name with no person row (or quick-add creates a minimal adult person row — implementation choice, leaning **person row** so repeat visitors autocomplete) |

### notification / roster_import
Unchanged from v0.1 (notification: person_id, guardian_id, event_id, channel, status, twilio_sid; roster_import: counts + retained original file).

## Import Column Mapping (Trail Life Connect member export)

Header row located by scanning for "Member Number" (title row above it is skipped; works on filtered exports).

| xlsx column | destination | notes |
|---|---|---|
| Youth (Y/N) | person.is_youth | discriminator |
| Member Number | person.member_id | upsert key; blank → match by name+birthdate for existing unregistered adults, else insert |
| Last/First/Nickname | names | |
| Role | person.role | |
| Patrol / Current Level | patrol / level | |
| Email | youth → tlc_username; adult → email | never treat youth Email as an address |
| Adult Cc Email | guardian-link matching only | not stored on the youth |
| Mobile/Home/Work Phone | person.phone_* | |
| Birthdate | retained for adult fallback matching | not otherwise displayed |
| remaining columns (address, shirt size, skills, forms…) | ignored v1 | raw file retained for audit if ever needed |

Guardian auto-link pass after upsert: youth Adult Cc Email ↔ adult email (case-insensitive) → suggest link; fallback same last name + address; suggestions written with `source = import_*`, admin `manual` rows untouched.

## Key Queries (deltas from v0.1)

**Who's still here:** unchanged, now includes adults when event.track_adults = 1; per-patrol station view filters youth by patrol.

**Race protection:** on submit the server re-validates open state per person; an `out` for an already-closed record is rejected with a clear client message (client_uuid still dedupes retries).

**Emergency prefill:** last_emerg_phone_1/2 → else primary authorized guardian's phone_mobile.

**Visitor/unregistered merge:** repoint txn_person, person_guardian, notification rows to the roster person id; mark source row `merged`.
