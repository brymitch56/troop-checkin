# Troop Check-In App — Requirements Specification

Trail Life Troop NY-2911 · Draft v0.1

## Purpose

Replace paper sign-in/out sheets with an installable web app (PWA) running on troop devices. Parents/guardians sign youth in at drop-off and out at pickup with an on-screen signature. The system tracks who signed, when, for which event, and notifies guardians who haven't signed out by end of event.

## Functional Requirements

### FR-1 Badge scanning
- Scan the QR code on a youth's name tag using the device camera, **or** via a Bluetooth 2D scanner paired in HID keyboard mode — a global keyboard-wedge listener captures the typed payload + Enter, no field focus required. Both inputs feed the same cart; scanners suit high-throughput sign-in stations, camera covers patrol phones with no extra hardware.
- The QR payload format is `<membershipID> | <token>` — membership ID, space-pipe-space, then a short alphanumeric token unique to the badge. Store the **full raw payload** as the badge code. Matching: exact raw-payload match first; if no badge match but the membership ID (left of the pipe) matches a roster member, offer to link the new payload to that member (covers reprinted badges, where the token changes but the ID doesn't). Linking is staff-confirmed.

### FR-2 Multi-youth transactions
- Scanning multiple badges adds each youth to a "cart" for the current transaction.
- Youth in one cart may span siblings/families only if the same signer is authorized for all; the app warns if the selected signer is not authorized for every youth in the cart.
- One signature completes the transaction for all youth in the cart.

### FR-3 Sign-in / sign-out flow
1. Staff member is logged in on the device.
2. Scan badge(s) or look up by name.
3. App determines direction automatically: youth with no open sign-in for the matched event → sign IN; youth with an open sign-in → sign OUT. Mixed carts are split or corrected by staff.
4. Signer selects their name from the authorized-pickup list for the youth (union of lists for a multi-youth cart, with per-youth authorization check).
5. Signer signs on screen; transaction is saved with timestamp, event, staff member, signer, and signature image.

### FR-4 Authorized pickup lists
- Each youth has a list of authorized adults (name, relationship, phone).
- The sign-out screen shows only authorized names for selection; an "other adult" override exists but requires staff confirmation and records the typed name — flagged in reports.

### FR-5 No-badge fallback
- Name search against the active roster (type-ahead). Selecting a youth adds them to the cart exactly as a scan would.

### FR-6 Visitors
- Quick-add form: youth name, guardian name, guardian phone, optional notes.
- Visitor records participate in normal sign-in/out and notifications.
- Admin can merge a visitor record into a roster record after a later xlsx import (attendance history transfers).

### FR-7 Events
- Nightly (and on-demand) sync of the troop iCal feed into a local events table.
- Transaction event matching: events whose start–end window contains the current time. One match → auto-select. Multiple simultaneous events → staff picks from a list. No match → staff creates a manual event or picks a nearby one.
- Multi-day events: the sign-in's event carries through — a sign-out days later attaches to the same event via the open sign-in record, not by re-matching the clock.
- Manual event creation/edit for anything not on the calendar.

### FR-8 Notifications
- Configurable trigger: N minutes after event end (or a set time), any youth with an open sign-in generates a notification to their primary guardian.
- Channel: SMS via Twilio (requires A2P 10DLC sole-prop registration) with reply-to-confirm ("Reply Y to confirm pickup"); a Y reply closes the open sign-in as "confirmed by SMS" with the message SID stored in place of a signature.
- Parents do not install the app (staff/leader-only tool), so SMS is the sole parent-facing channel. Optional future: push notifications to on-duty leaders when open sign-ins remain after event end.

### FR-9 Staff authentication
- Staff accounts with individual credentials (name + PIN on kiosk devices; password for admin).
- Roles: **door staff** (run check-in/out, add visitors) and **admin** (roster import, events, guardians, reports, settings, database).
- Login/logout on the device; idle auto-logout configurable; every transaction records the logged-in staff member.

### FR-10 Roster import
- Admin uploads the Trail Life Connect member xlsx. The export has a title row, then headers; the parser locates the header row by finding "Member Number" (position-independent, so pre-filtered exports also work).
- The file may contain youth only, or youth **and** adults — the **Youth (Y/N)** column discriminates. Both types are imported; only youth and registered adults carry member numbers.
- Youth mapping: name, nickname, Member Number, Patrol, Current Level, guardian email from **Adult Cc Email** (the youth "Email" column holds a TLC username, not an email — never treat it as one).
- Adult mapping: name, role, Member Number (registered adults/leaders only), Mobile/Home/Work phones, email.
- Guardian auto-linking (suggestions only): match a youth's Adult Cc Email against adult Email addresses (case-insensitive); fall back to same last name + address. Admin edits to authorized lists are authoritative and are **never overwritten by re-imports**.
- Matching always keys on Member Number + Youth flag — never name alone (same-name parent/youth pairs exist).
- People absent from a new file are marked **inactive** (never deleted); a youth-only export leaves existing adult records untouched rather than deactivating them.
- Import preview shows adds / updates / deactivations before commit; every import is logged with the original file retained.

### FR-12 Adult attendance
- For designated events, adults are checked in/out alongside youth for headcount/accountability. Adults never sign and never require a guardian.
- Registered adults check in by badge scan (if badged) or name search; unregistered adults are recorded by typed name only via quick-add.

### FR-13 Emergency contact at sign-in
- Every youth sign-in — meetings and events alike — shows an emergency contact phone field.
- Prefill order: last emergency number used for that youth → primary guardian's mobile. Because the value persists until changed, it adds no friction on routine nights; the signer just glances and confirms. Always editable; optional secondary number field.
- Captured numbers are stored on the sign-in record (point-in-time snapshot for that event) and become the youth's new default.

### FR-11 Remote access & reporting
- Full app reachable remotely through Cloudflare Tunnel.
- Admin area (including database browsing/export) additionally protected by Cloudflare Access.
- Reports: attendance by event, open sign-ins, override usage, visitor log; CSV export.

## Non-Functional Requirements

- **Offline-first:** app shell and roster cached on device; transactions queue in IndexedDB when offline and sync when connectivity returns (campouts, church basements).
- **Installable PWA** on iOS Safari and Android Chrome; camera scanning must work on both.
- **Privacy:** youth PII and signatures never leave the Pi except via authenticated access; nightly encrypted backup off-device.
- **Auditability:** transactions are append-only; corrections are new records referencing the original.

## Out of Scope (v1)

Payment tracking, advancement records, parent self-service accounts. Multi-troop events (visiting troops without pre-loaded rosters) are deferred to the Phase 5 backlog, not permanently excluded.

## Open Questions

All prior open questions answered — see FR-10 for the confirmed xlsx layout (title row + header row keyed on "Member Number"; Youth Y/N flag; Adult Cc Email as the guardian email; youth "Email" is a TLC username). Remaining decisions are design-level and tracked in the build plan.
