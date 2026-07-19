'use strict';
// Minimal .env loader (no dependency). Values already in process.env win.
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

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  TROOP_ID: process.env.TROOP_ID || 'NY-0000',
  TROOP_NAME: process.env.TROOP_NAME || 'Troop Check-In',
  ICAL_URL: process.env.ICAL_URL || '',
  SMS_ENABLED: process.env.SMS_ENABLED === 'true',
};
