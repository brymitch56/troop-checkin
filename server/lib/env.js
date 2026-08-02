'use strict';
// Minimal .env loader (no dependency). Values already in process.env win.
//
// Timezone: putting `TZ=America/New_York` (any IANA zone) in .env sets
// process.env.TZ here — BEFORE anything constructs a Date or touches SQLite —
// so both JavaScript local time and SQLite's 'localtime' modifier (used by
// the day-granular event past-rules) follow it, with DST handled
// automatically. Without it, the host OS timezone applies (set the Pi's with
// `sudo timedatectl set-timezone America/New_York`). Absolute-time logic
// (notification sweep timing, txn timestamps) is UTC-based and unaffected.
const fs = require('fs');
const path = require('path');

// Where the .env file lives. Default: repo root (unchanged for every existing
// install). ENV_FILE overrides it for containers, where the image is
// read-only/ephemeral and config must live on a mounted volume
// (e.g. ENV_FILE=/app/config/.env in docker-compose.yml). Everything that
// reads OR writes the .env file (loader, credCrypto key append, the /setup
// wizard) resolves it through this one constant.
const ENV_PATH = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(__dirname, '..', '..', '.env');
try {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — defaults apply */ }

// Live getters (not a snapshot) so late changes to process.env — tests,
// systemd drop-ins — are always honored.
module.exports = {
  ENV_PATH,
  get PORT() { return Number(process.env.PORT) || 3000; },
  get THEME() { return process.env.THEME || 'traillife'; },
  // In-process schedules (cross-platform replacement for systemd timers; the
  // Pi keeps its systemd timer and leaves SCHEDULE_ROSTER_SYNC unset):
  // SCHEDULE_BACKUP: 'nightly' (default, matches historic behavior) | 'off'
  // SCHEDULE_ROSTER_SYNC: 'off' (default) | 'weekly' (Sun 03:30 local +
  // random 0-30 min jitter, mirroring the systemd timer template)
  get SCHEDULE_BACKUP() { return (process.env.SCHEDULE_BACKUP || 'nightly').toLowerCase(); },
  get SCHEDULE_ROSTER_SYNC() { return (process.env.SCHEDULE_ROSTER_SYNC || 'off').toLowerCase(); },
  get TROOP_ID() { return process.env.TROOP_ID || 'NY-0000'; },
  get TROOP_NAME() { return process.env.TROOP_NAME || 'Troop Check-In'; },
  get ICAL_URL() { return process.env.ICAL_URL || ''; },
  get SMS_ENABLED() { return process.env.SMS_ENABLED === 'true'; },
  get TWILIO_ACCOUNT_SID() { return process.env.TWILIO_ACCOUNT_SID || ''; },
  get TWILIO_AUTH_TOKEN() { return process.env.TWILIO_AUTH_TOKEN || ''; },
  get TWILIO_FROM_NUMBER() { return process.env.TWILIO_FROM_NUMBER || ''; },
  // public HTTPS origin (Cloudflare tunnel) — required to validate Twilio
  // webhook signatures, e.g. https://checkin.example.org
  get PUBLIC_URL() { return (process.env.PUBLIC_URL || '').replace(/\/$/, ''); },
};
