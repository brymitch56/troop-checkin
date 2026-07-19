# Troop Check-In App — Architecture

Draft v0.1 · Self-hosted on Raspberry Pi

## Overview

```
[Parent/Staff device: PWA]
   │  HTTPS
   ▼
[Cloudflare Tunnel] ──► [Cloudflare Access]  (admin routes only)
   │
   ▼
[Raspberry Pi]
   ├─ Node.js + Express (app server + API)
   ├─ SQLite (better-sqlite3)
   ├─ Signature images on disk (referenced from DB)
   ├─ Cron jobs: iCal sync · notification sweep · nightly backup
   └─ cloudflared (tunnel daemon)

[Twilio] ◄── outbound SMS
[Twilio webhook] ──► /api/sms/inbound (via tunnel)
[iCal feed] ──► nightly fetch
[Backup target: Google Drive via rclone]
```

## Component Choices & Rationale

**Server: Node.js + Express.** Keeps the whole stack in JavaScript (aligns with existing Apps Script experience). Express is boring and well-documented; no framework churn on a Pi that should run untouched for years.

**Database: SQLite via better-sqlite3.** Single file, synchronous API (simpler code, fine at troop scale), trivial backup (copy the file with `VACUUM INTO` or Litestream), no service to babysit. WAL mode for concurrent readers during a busy check-in night.

**Frontend: vanilla JS PWA** (or lightweight Svelte if preferred later). Key libraries:
- QR scanning: native `BarcodeDetector` API where available, `zxing-js` fallback (covers iOS Safari).
- Signatures: `signature_pad` (canvas), exported as PNG.
- xlsx parsing: `SheetJS` server-side.
- iCal parsing: `node-ical` (Trail Life Connect publishes every event individually — no RRULE expansion needed, which keeps the sync job simple).

**Remote access: Cloudflare Tunnel** (`cloudflared` on the Pi). No open ports, free, automatic TLS, survives dynamic home IP. A troop subdomain (e.g., `checkin.<yourdomain>`) points at the tunnel.

**Admin protection: Cloudflare Access** in front of `/admin/*` and `/api/admin/*` — email one-time-code restricted to an allowlist. This layers on top of in-app staff auth, so remote database access requires both.

**SMS: Twilio.** Outbound reminders via REST API; inbound replies hit `/api/sms/inbound` (Twilio webhook through the tunnel, validated with Twilio's request signature). Requires A2P 10DLC sole-proprietor registration (~$1.50/mo number + per-message fees). Deferrable to a later phase.

## Authentication Model

- **Staff sessions:** server-side sessions (cookie, httpOnly). Kiosk login = staff picks name + enters PIN (hashed, argon2). Admin login = password. Idle timeout configurable per role.
- **Kiosk device trust:** optional device registration (long-lived device token) so only known tablets can reach the check-in screen even before staff login.
- **Roles:** `door` and `admin`, enforced server-side per route.

## Offline-First Design

- Service worker caches the app shell and the active roster + authorized-pickup lists (refreshed each session start).
- Transactions (including signature PNG as a data URL) queue in IndexedDB with a client-generated UUID.
- Sync worker POSTs queued transactions when online; server dedupes on the UUID, so retries are safe.
- Direction logic (in vs. out) runs client-side against last-known state when offline; server reconciles on sync and flags conflicts for admin review rather than guessing.

## Event Matching Logic

1. On each transaction, query events where `start <= now <= end` (all-day/multi-day events use full-day bounds).
2. Exactly one → auto-attach. Multiple → staff selects. None → offer nearest upcoming/recent event or manual creation.
3. Sign-outs always attach to the event of the youth's **open sign-in record**, never re-matched by clock — this makes multi-day events and late pickups correct by construction.

## Backups & Reliability

- Nightly cron: `VACUUM INTO` snapshot + signature directory → tar → `rclone` to Google Drive (encrypted remote). Keep 30 dailies, 12 monthlies.
- Optional: Litestream continuous replication if you want point-in-time recovery.
- Pi hardening: read-mostly SD card or boot from SSD; watchdog + `systemd` restart policies; UPS hat optional.
- Failure mode at a meeting: PWA offline queue means check-in continues even if the Pi or internet is down; data syncs afterward.

## Security & Privacy Notes

- All traffic TLS via Cloudflare; tunnel means no inbound firewall holes.
- PII (youth names, guardian phones, signatures) stored only on the Pi + encrypted backups.
- Append-only transaction log; staff attribution on every record.
- Twilio webhook signature validation; rate limiting on auth endpoints.
