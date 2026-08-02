'use strict';
// Cross-platform test entry (`npm test`). Why not `node --test test/*.test.js`?
// PowerShell/cmd don't expand globs, so that breaks on Windows; and pointing
// --test at the directory would also pull in e2e-browser.js, which is the
// separate ADVISORY browser suite (needs puppeteer + real Chrome) and must
// never gate the unit run. So: glob the unit files ourselves, hand Node the
// explicit list.
const { readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const files = readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('test', f));

const r = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});
process.exit(r.status === null ? 1 : r.status);
