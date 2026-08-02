'use strict';
// In-process scheduler: next-occurrence date math (the part that replaces
// systemd's OnCalendar) and the env toggles that drive it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// isolate: the toggle tests pull in lib/backup + lib/syncRunner, which open
// the database — keep that in a temp DATA_DIR
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sched-'));

const { nextDaily, nextWeekly } = require('../server/lib/scheduler');

test('nextDaily: later today when the time is still ahead', () => {
  const from = new Date(2026, 7, 3, 1, 0, 0); // Mon Aug 3 2026, 01:00 local
  const next = nextDaily(from, 3, 15);
  assert.deepEqual([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()],
    [2026, 7, 3, 3, 15]);
});

test('nextDaily: tomorrow when the time already passed (and exactly-now rolls over)', () => {
  const passed = nextDaily(new Date(2026, 7, 3, 9, 0, 0), 3, 15);
  assert.equal(passed.getDate(), 4);
  const exact = nextDaily(new Date(2026, 7, 3, 3, 15, 0), 3, 15);
  assert.equal(exact.getDate(), 4); // strictly after
});

test('nextWeekly: next Sunday 03:30 from a mid-week point', () => {
  const from = new Date(2026, 7, 5, 12, 0, 0); // Wed Aug 5 2026
  const next = nextWeekly(from, 0, 3, 30);
  assert.equal(next.getDay(), 0);
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [9, 3, 30]);
});

test('nextWeekly: same-day handling — before fires today, after fires next week', () => {
  const sunEarly = new Date(2026, 7, 9, 1, 0, 0); // Sun Aug 9, 01:00
  assert.equal(nextWeekly(sunEarly, 0, 3, 30).getDate(), 9);
  const sunLate = new Date(2026, 7, 9, 9, 0, 0); // Sun Aug 9, 09:00
  assert.equal(nextWeekly(sunLate, 0, 3, 30).getDate(), 16);
});

test('nextDaily crosses month and year boundaries', () => {
  const eom = nextDaily(new Date(2026, 7, 31, 9, 0, 0), 3, 15);
  assert.deepEqual([eom.getMonth(), eom.getDate()], [8, 1]);
  const eoy = nextDaily(new Date(2026, 11, 31, 9, 0, 0), 3, 15);
  assert.deepEqual([eoy.getFullYear(), eoy.getMonth(), eoy.getDate()], [2027, 0, 1]);
});

test('env toggles: backup schedule honors SCHEDULE_BACKUP=off, sync honors weekly', () => {
  const env = require('../server/lib/env');
  assert.equal(env.SCHEDULE_BACKUP, 'nightly'); // default preserves historic behavior
  assert.equal(env.SCHEDULE_ROSTER_SYNC, 'off'); // default: Pi keeps its systemd timer

  process.env.SCHEDULE_BACKUP = 'off';
  assert.equal(require('../server/lib/backup').scheduleNightly(), null);
  delete process.env.SCHEDULE_BACKUP;

  // default 'off' => no timer armed
  assert.equal(require('../server/lib/syncRunner').scheduleWeekly(), null);
  // 'weekly' => a timer is armed (unref'd — never keeps the process alive)
  process.env.SCHEDULE_ROSTER_SYNC = 'weekly';
  const t = require('../server/lib/syncRunner').scheduleWeekly();
  assert.ok(t);
  clearTimeout(t);
  delete process.env.SCHEDULE_ROSTER_SYNC;
});
