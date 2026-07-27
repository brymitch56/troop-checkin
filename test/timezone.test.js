'use strict';
// Timezone behavior: TZ from .env must drive BOTH JavaScript local time
// (fetch filename stamps) and SQLite's 'localtime' modifier (the day-granular
// event past-rules), with DST handled by the IANA zone database. Spawned
// child processes make the TZ deterministic regardless of the sandbox zone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tz-'));

const root = path.join(__dirname, '..');
const runNode = (code, tz) => spawnSync(process.execPath, ['-e', code], {
  cwd: root,
  env: { ...process.env, TZ: tz, DATA_DIR: process.env.DATA_DIR },
  encoding: 'utf8', timeout: 20000,
});

test('localStamp: filename date follows TZ, not UTC (the "fetched tomorrow" bug)', () => {
  // 2026-07-26 23:30 UTC = Sat 19:30 in New York (EDT) but Sun 13:30 in Kiribati (UTC+14)
  const code = `const F = require('./server/scripts/fetch-roster');
    console.log(F.localStamp(new Date('2026-07-26T23:30:00Z')));`;
  const ny = runNode(code, 'America/New_York');
  assert.equal(ny.stdout.trim(), '2026-07-26-1930', ny.stderr);
  const kiritimati = runNode(code, 'Pacific/Kiritimati');
  assert.equal(kiritimati.stdout.trim(), '2026-07-27-1330', kiritimati.stderr);
});

test('localStamp: DST is automatic (EST in January, EDT in July)', () => {
  const code = (iso) => `const F = require('./server/scripts/fetch-roster');
    console.log(F.localStamp(new Date('${iso}')));`;
  assert.equal(runNode(code('2026-01-15T20:00:00Z'), 'America/New_York').stdout.trim(),
    '2026-01-15-1500'); // UTC-5
  assert.equal(runNode(code('2026-07-15T20:00:00Z'), 'America/New_York').stdout.trim(),
    '2026-07-15-1600'); // UTC-4
});

test("SQLite 'localtime' (event past-rules) honors TZ set before the DB loads", () => {
  const code = `const { db } = require('./server/db');
    console.log(db.prepare("SELECT datetime('2026-07-27 00:30:00', 'localtime') AS t").get().t);`;
  const ny = runNode(code, 'America/New_York');
  assert.equal(ny.stdout.trim(), '2026-07-26 20:30:00', ny.stderr); // EDT: still Saturday
  const utc = runNode(code, 'UTC');
  assert.equal(utc.stdout.trim(), '2026-07-27 00:30:00');
});

test('.env TZ reaches process.env via env.js (repo-shaped temp copy)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tzenv-'));
  fs.mkdirSync(path.join(tmp, 'server', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(root, 'server', 'lib', 'env.js'), path.join(tmp, 'server', 'lib', 'env.js'));
  fs.writeFileSync(path.join(tmp, '.env'), 'TZ=America/Chicago\n');
  const env = { ...process.env };
  delete env.TZ;
  const r = spawnSync(process.execPath,
    ['-e', `require('./server/lib/env');
      console.log(process.env.TZ, '|', new Date('2026-07-15T20:00:00Z').getHours());`],
    { cwd: tmp, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.stdout.trim(), 'America/Chicago | 15', r.stderr); // CDT = UTC-5
});
