'use strict';
// First-run configuration API, reachable ONLY while the instance is
// unconfigured (the gate in server/index.js enforces that; belt-and-braces
// checks here too). One POST configures everything: writes .env, runs
// migrations, creates the first admin, and latches the instance configured —
// no restart required (env.js getters are live).
//
// Security posture: never asks for secrets it doesn't need (no Twilio/TLC
// credentials here — optional features stay OFF and are configured later via
// their guide chapters), binds exactly like the rest of the app, and is
// permanently disabled the moment configuration exists.
const fs = require('fs');
const path = require('path');
const express = require('express');
const theme = require('../lib/theme');
const setupState = require('../lib/setupState');

const router = express.Router();
router.use(express.json({ limit: '64kb' }));

const gone = (res) => res.status(403).json({ error: 'This instance is already configured. Setup is disabled.' });

router.get('/state', (req, res) => {
  if (setupState.isConfigured()) return gone(res);
  res.json({
    configured: false,
    presets: theme.PRESETS,
    vars: theme.VARS,
    defaults: { troop_id: 'NY-0000', troop_name: 'Troop Check-In', timezone: 'America/New_York' },
  });
});

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

const ROSTER_SOURCE = { traillife: 'Trail Life Connect', ahg: 'AHGfamily', generic: '' };

router.post('/', (req, res) => {
  if (setupState.isConfigured()) return gone(res);

  const b = req.body || {};
  const troopId = String(b.troop_id || '').trim();
  const troopName = String(b.troop_name || '').trim();
  const program = String(b.program || 'generic').toLowerCase();
  const tz = String(b.timezone || '').trim();
  const adminName = String(b.admin_name || '').trim();
  const adminPassword = String(b.admin_password || '');

  const bad = (msg) => res.status(422).json({ error: msg });
  if (!troopId || troopId.length > 40) return bad('Troop number/ID is required (max 40 characters).');
  if (!troopName || troopName.length > 80) return bad('Troop name is required (max 80 characters).');
  if (!theme.PRESETS[program]) return bad('Unknown program preset.');
  if (!tz || !validTimezone(tz)) return bad('Please pick a valid timezone.');
  if (!adminName || adminName.length > 80) return bad('Admin name is required.');
  if (adminPassword.length < 8) return bad('Admin password must be at least 8 characters.');

  // Color customizations: only overrides that differ from the chosen preset
  // are written, each validated as #RRGGBB.
  const overrides = {};
  const preset = theme.PRESETS[program];
  if (b.colors && typeof b.colors === 'object') {
    for (const v of theme.VARS) {
      const c = b.colors[v];
      if (c === undefined || c === null || c === '') continue;
      if (!/^#[0-9a-fA-F]{6}$/.test(String(c))) return bad(`Invalid color for --${v} (use #RRGGBB).`);
      const hex = String(c).toUpperCase();
      if (hex !== preset[v].toUpperCase()) overrides[v] = hex;
    }
  }

  // Everything validated — apply. Order matters: migrations, then the admin
  // account, then .env (the durable "configured" marker) last, so a crash
  // mid-way can never strand a .env-configured instance with no admin.
  try {
    require('../migrate'); // idempotent; applies any pending migrations

    const { db } = require('../db');
    const auth = require('../auth');
    const existing = db.prepare('SELECT COUNT(*) c FROM staff').get().c;
    if (existing > 0) { setupState.markConfigured(); return gone(res); }
    db.prepare('INSERT INTO staff (name, role, password_hash) VALUES (?, ?, ?)')
      .run(adminName, 'admin', auth.hashSecret(adminPassword));

    const lines = [
      '# Troop Check-In configuration — written by the first-run setup wizard on ' + new Date().toISOString(),
      '# Reference for every available option: .env.example',
      `TROOP_ID=${troopId}`,
      `TROOP_NAME=${troopName}`,
      `TZ=${tz}`,
      `THEME=${program}`,
    ];
    for (const [v, hex] of Object.entries(overrides)) lines.push(`${theme.envName(v)}=${hex}`);
    if (ROSTER_SOURCE[program]) lines.push(`ROSTER_SOURCE_NAME=${ROSTER_SOURCE[program]}`);
    lines.push('', '# Optional features (SMS, roster sync, tunnel, off-site backups) are OFF.',
      '# Each has a guide chapter under docs/ — add its settings here when ready.', '');

    const { ENV_PATH } = require('../lib/env');
    const tmp = ENV_PATH + '.tmp';
    fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
    fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
    fs.renameSync(tmp, ENV_PATH);

    // make the running process see the new config immediately
    process.env.TROOP_ID = troopId;
    process.env.TROOP_NAME = troopName;
    process.env.TZ = tz;
    process.env.THEME = program;
    for (const [v, hex] of Object.entries(overrides)) process.env[theme.envName(v)] = hex;

    setupState.markConfigured();
    res.json({ ok: true });
  } catch (e) {
    console.error('setup failed:', e.message);
    res.status(500).json({ error: 'Setup failed on the server: ' + e.message });
  }
});

module.exports = router;
