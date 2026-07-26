'use strict';
// Fail-fast startup self-check.
//
// Why this exists: on the 2026-07-26 deploy, server/lib/membership.js landed
// as a 0-byte file on the Pi even though the committed git blob was correct.
// A plain require() of an empty module SUCCEEDS (exports = {}), destructuring
// a missing export just yields `undefined`, and the service boots "healthy"
// (healthz ok) — then throws "x is not a function" much later, on the first
// code path that actually calls it. This check runs before app.listen and
// makes a corrupt/empty core module REFUSE to start the service instead:
// systemd's Restart=always keeps retrying and the journal shows the reason
// on every cycle, which is the intended loud signal.
//
// Deliberately dependency-free and fast: just typeof checks on modules the
// app loads anyway. Keep the list in sync with what callers destructure.

const CRITICAL = [
  ['server/lib/membership.js', () => require('./membership'),
    { functions: ['normalizeDateCell', 'daysUntil', 'expiringPeople'] }],
  ['server/lib/rosterImport.js', () => require('./rosterImport'),
    { functions: ['parseWorkbook', 'computePreview', 'applyImport'], nonEmptyArrays: ['UPDATABLE'] }],
  ['server/lib/sms.js', () => require('./sms'),
    { functions: ['configured', 'send', 'validateSignature'] }],
  ['server/lib/notifySweep.js', () => require('./notifySweep'),
    { functions: ['sweep', 'scheduleSweep'] }],
];

// Pure assertion (used directly by tests): throws on the first problem.
function assertExports(name, mod, spec) {
  if (!mod || typeof mod !== 'object' || !Object.keys(mod).length) {
    throw new Error(`${name}: module has no exports (empty or corrupt file?)`);
  }
  for (const fn of spec.functions || []) {
    if (typeof mod[fn] !== 'function') {
      throw new Error(`${name}: missing export ${fn} (expected a function, got ${typeof mod[fn]})`);
    }
  }
  for (const key of spec.nonEmptyArrays || []) {
    if (!Array.isArray(mod[key]) || mod[key].length === 0) {
      throw new Error(`${name}: missing export ${key} (expected a non-empty array)`);
    }
  }
}

// Runs every check; returns a list of failure messages (empty = healthy).
// A module that throws at require() time is a failure too, not a crash.
function runSelfCheck(list = CRITICAL) {
  const failures = [];
  for (const [name, load, spec] of list) {
    try {
      assertExports(name, load(), spec);
    } catch (e) {
      failures.push(e.message);
    }
  }
  return failures;
}

// Boot entry point: log clearly and refuse to start on any failure.
function selfCheckOrExit(list = CRITICAL) {
  const failures = runSelfCheck(list);
  if (failures.length) {
    for (const f of failures) console.error(`STARTUP SELF-CHECK FAILED: ${f}`);
    console.error(
      'Refusing to start: a core module is corrupt or incomplete. ' +
      'On the Pi: `git status` should show the damaged file; `git checkout -- <file>` ' +
      'restores it from the (normally intact) git object; then re-run the deploy verifier.'
    );
    process.exit(1);
  }
}

module.exports = { CRITICAL, assertExports, runSelfCheck, selfCheckOrExit };
