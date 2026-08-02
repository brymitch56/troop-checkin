'use strict';
// Single owner of the roster-fetch child process, shared by the admin
// "Sync now" button and the in-process weekly schedule so "one sync at a
// time" holds across both triggers. Spawns the SAME script the systemd
// timer runs (server/scripts/fetch-roster.js) via process.execPath, so the
// fetch behaves identically on Linux, Windows, and in Docker.
const path = require('path');

let child = null; // { startedAt } while a fetch is running

function status() {
  return { running: !!child, started_at: child ? child.startedAt : null };
}

// Start a fetch. Returns { started: true } or { started: false, reason }.
function start() {
  if (child) return { started: false, reason: 'A sync is already running.' };
  const { spawn } = require('child_process');
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'fetch-roster.js')],
    { stdio: 'ignore', env: process.env });
  child = { startedAt: new Date().toISOString() };
  const done = () => { child = null; clearTimeout(killer); };
  proc.on('exit', done);
  proc.on('error', done);
  // hard stop: the poll loop is self-limiting, but never let a wedged child
  // hang the "running" state forever
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 10 * 60 * 1000);
  killer.unref();
  return { started: true };
}

// Weekly in-process schedule (SCHEDULE_ROSTER_SYNC=weekly): Sunday 03:30
// local + random 0-30 min jitter — the same cadence as the systemd timer
// template. The Pi keeps its systemd timer and leaves this unset; Windows
// and Docker installs use this instead. Each fire re-checks the kill switch
// and credentials live, and quietly skips when unconfigured — exactly like
// the standalone script would.
function scheduleWeekly() {
  const env = require('./env');
  if (env.SCHEDULE_ROSTER_SYNC !== 'weekly') return null;
  const rosterSync = require('./rosterSync');
  return require('./scheduler').scheduleWeekly('roster sync', 0, 3, 30, () => {
    if (String(process.env.TLC_ENABLED || 'true').toLowerCase() === 'false') return;
    if (!rosterSync.credentialInfo().source) return; // nothing configured yet
    start();
  }, 30 * 60 * 1000);
}

module.exports = { start, status, scheduleWeekly };
