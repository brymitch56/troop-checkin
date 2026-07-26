'use strict';
// Fail-fast startup self-check: the real modules must pass; a stub with a
// missing export must fail loudly; and — end to end — truncating a core
// module must make `node server/index.js` refuse to start with exit 1
// (the 2026-07-26 deploy caught membership.js as a 0-byte file that booted
// "healthy"; this is the regression net for that class of corruption).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-selfchk-'));
require('../server/migrate'); // rosterImport/notifySweep require a live db

const selfcheck = require('../server/lib/selfcheck');

test('runSelfCheck: the real critical modules all pass', () => {
  assert.deepEqual(selfcheck.runSelfCheck(), []);
});

test('assertExports: missing function export fails with a clear message', () => {
  const stub = { daysUntil: () => {}, expiringPeople: () => {} }; // no normalizeDateCell
  assert.throws(
    () => selfcheck.assertExports('server/lib/membership.js', stub,
      { functions: ['normalizeDateCell', 'daysUntil', 'expiringPeople'] }),
    /membership\.js: missing export normalizeDateCell/);
});

test('assertExports: empty module (the 0-byte case) fails', () => {
  // require() of a 0-byte file yields exactly this: an empty exports object
  assert.throws(
    () => selfcheck.assertExports('server/lib/membership.js', {}, { functions: ['daysUntil'] }),
    /no exports \(empty or corrupt file\?\)/);
});

test('assertExports: empty UPDATABLE array fails', () => {
  const stub = { parseWorkbook: () => {}, computePreview: () => {}, applyImport: () => {}, UPDATABLE: [] };
  assert.throws(
    () => selfcheck.assertExports('server/lib/rosterImport.js', stub,
      { functions: ['parseWorkbook', 'computePreview', 'applyImport'], nonEmptyArrays: ['UPDATABLE'] }),
    /missing export UPDATABLE \(expected a non-empty array\)/);
});

test('runSelfCheck: a module that throws at require() is a failure, not a crash', () => {
  const list = [['server/lib/broken.js', () => { throw new Error('SyntaxError: oops'); }, { functions: ['x'] }]];
  const failures = selfcheck.runSelfCheck(list);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /oops/);
});

test('selfCheckOrExit: exits 1 and logs STARTUP SELF-CHECK FAILED on a bad module', () => {
  const errs = [];
  let exitCode = null;
  const origExit = process.exit, origErr = console.error;
  process.exit = (code) => { exitCode = code; throw new Error('exit-called'); };
  console.error = (m) => errs.push(String(m));
  try {
    assert.throws(() =>
      selfcheck.selfCheckOrExit([['server/lib/membership.js', () => ({}), { functions: ['daysUntil'] }]]),
      /exit-called/);
  } finally {
    process.exit = origExit; console.error = origErr;
  }
  assert.equal(exitCode, 1);
  assert.ok(errs.some((m) => m.startsWith('STARTUP SELF-CHECK FAILED:')));
});

test('end to end: truncated membership.js makes `node server/index.js` exit 1', () => {
  // copy the app into a temp dir (sources only), truncate one core module to
  // 0 bytes exactly like the Pi incident, and try to boot it for real
  const root = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-boot-'));
  for (const dir of ['server', 'server/lib', 'server/routes', 'server/migrations', 'server/scripts', 'public', 'public/vendor']) {
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    for (const f of fs.readdirSync(path.join(root, dir))) {
      const src = path.join(root, dir, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(tmp, dir, f));
    }
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
  const env = { ...process.env, DATA_DIR: path.join(tmp, 'data'), PORT: '0' };
  const mig = spawnSync(process.execPath, ['server/migrate.js'], { cwd: tmp, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(mig.status, 0, `migrate failed in temp copy: ${mig.stderr}`);
  fs.writeFileSync(path.join(tmp, 'server', 'lib', 'membership.js'), ''); // the 0-byte corruption

  const r = spawnSync(process.execPath, ['server/index.js'], {
    cwd: tmp, env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /STARTUP SELF-CHECK FAILED: server\/lib\/membership\.js/);
  assert.match(r.stderr, /Refusing to start/);

  // and the untampered copy must boot (prints the listening line, then we kill it)
  fs.copyFileSync(path.join(root, 'server', 'lib', 'membership.js'),
    path.join(tmp, 'server', 'lib', 'membership.js'));
  const ok = spawnSync(process.execPath,
    ['-e', `
      const { spawn } = require('child_process');
      const p = spawn(process.execPath, ['server/index.js'], { env: process.env });
      let out = '';
      p.stdout.on('data', (d) => {
        out += d;
        if (out.includes('listening')) { p.kill(); console.log('BOOTED'); process.exit(0); }
      });
      p.stderr.on('data', (d) => process.stderr.write(d));
      p.on('exit', (c) => { console.error('exited early: ' + c); process.exit(1); });
      setTimeout(() => { p.kill(); console.error('no listening line'); process.exit(1); }, 15000);
    `],
    { cwd: tmp, env, encoding: 'utf8', timeout: 25000 });
  assert.match(ok.stdout, /BOOTED/, `healthy copy failed to boot; stderr: ${ok.stderr}`);
});
