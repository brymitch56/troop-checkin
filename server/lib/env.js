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

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
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
  get PORT() { return Number(process.env.PORT) || 3000; },
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
