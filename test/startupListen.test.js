'use strict';
// A bind failure must be FATAL. Express 5 changed app.listen(): instead of
// throwing on EADDRINUSE/EACCES it hands the error to the listen callback. A
// callback that ignores its argument then logs "listening" with no port, and
// — because every scheduler timer is unref'd — the process exits 0, which
// systemd's Restart=on-failure reads as a clean stop and never restarts.
// This boots the real server on a port that is already taken.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

test('port already in use: `node server/index.js` exits non-zero and says why', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-listen-'));
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, resolve));
  const port = String(blocker.address().port);
  const env = {
    ...process.env, DATA_DIR: tmp, PORT: port,
    ENV_FILE: path.join(tmp, 'no-such.env'), // a developer's .env must not leak in
    SCHEDULE_BACKUP: 'off',
  };
  try {
    const mig = spawnSync(process.execPath, ['server/migrate.js'], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(mig.status, 0, `migrate failed: ${mig.stderr}`);

    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['server/index.js'], { cwd: root, env });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => { p.kill(); resolve({ code: 'timeout', out, err }); }, 20000);
      p.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });

    assert.equal(r.code, 1, `expected exit 1, got ${r.code}; stdout: ${r.out} stderr: ${r.err}`);
    assert.match(r.err, /could not listen on :\d+: .*EADDRINUSE/);
    assert.doesNotMatch(r.out, /listening on/, 'must not claim to be listening');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
