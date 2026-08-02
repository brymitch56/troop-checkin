'use strict';
// Is this instance configured? Drives the first-run /setup wizard gate.
//
// Configured means EITHER a .env file exists (every existing install — the
// Pi must never see the wizard) OR at least one staff account exists (covers
// installs configured entirely through the wizard before their first
// restart, and the test suites, which create staff directly). A brand-new
// checkout has neither, so — and only so — the wizard appears.
//
// Once configured the answer latches true for the life of the process:
// /setup can never reappear on a live instance. Re-running setup requires
// deliberate server-side action (delete .env AND the staff rows, restart),
// so the wizard cannot become a backdoor.
const fs = require('fs');

let latched = false;

function staffExists() {
  try {
    const { db } = require('../db');
    return db.prepare('SELECT COUNT(*) c FROM staff').get().c > 0;
  } catch {
    return false; // no staff table yet (migrations not run) — unconfigured
  }
}

function isConfigured() {
  if (latched) return true;
  const { ENV_PATH } = require('./env');
  if (fs.existsSync(ENV_PATH) || staffExists()) latched = true;
  return latched;
}

// Called by the wizard after it writes .env + creates the admin.
function markConfigured() { latched = true; }

// test-only
function resetForTest() { latched = false; }

module.exports = { isConfigured, markConfigured, resetForTest };
