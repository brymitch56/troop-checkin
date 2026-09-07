'use strict';
// Portal display labels: ROSTER_SOURCE_NAME/THEME drive what the UI and
// error messages call the member portal (Trail Life Connect vs AHGfamily).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-portal-'));

const auth = require('../server/auth');
const { db } = require('../server/db');
const portal = require('../server/lib/portal');

let server, base, adminCookie;
const saved = {};
const setEnv = (k, v) => { if (!(k in saved)) saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; };

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin P', 'admin', ?)`).run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await (await fetch(base + '/api/staff-list')).json());
  adminCookie = (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staff[0].id, pin: 'adminpass' }),
  })).headers.get('set-cookie').split(';')[0];
});
after(() => { for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; } server && server.close(); });

test('defaults: Trail Life Connect / TLC; t() is the identity; env-var names never touched', () => {
  setEnv('THEME', null); setEnv('ROSTER_SOURCE_NAME', null); setEnv('ROSTER_SOURCE_SHORT', null);
  assert.deepEqual(portal.label(), { name: 'Trail Life Connect', short: 'TLC' });
  const s = 'Save Trail Life Connect credentials (or set TLC_EMAIL in .env); re-check TLC.';
  assert.equal(portal.t(s), s);
});

test('THEME=ahg flips the default; explicit ROSTER_SOURCE_NAME/SHORT win', () => {
  setEnv('THEME', 'ahg');
  assert.deepEqual(portal.label(), { name: 'AHGfamily', short: 'AHGfamily' });
  assert.equal(portal.t('Re-check Trail Life Connect now; the TLC id (TLC_EMAIL stays).'),
    'Re-check AHGfamily now; the AHGfamily id (TLC_EMAIL stays).');
  setEnv('ROSTER_SOURCE_NAME', 'Scout Portal'); setEnv('ROSTER_SOURCE_SHORT', 'SP');
  assert.deepEqual(portal.label(), { name: 'Scout Portal', short: 'SP' });
  assert.equal(portal.t("TLC's export"), "SP's export");
  setEnv('ROSTER_SOURCE_NAME', null); setEnv('ROSTER_SOURCE_SHORT', null);
});

test('/api/config carries portal labels and server error strings follow them', async () => {
  setEnv('THEME', 'ahg');
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.deepEqual(cfg.portal, { name: 'AHGfamily', short: 'AHGfamily' });
  // a validation error that names the portal
  const pid = Number(db.prepare(`INSERT INTO person (is_youth, first_name, last_name) VALUES (1, 'Ben', 'Andrews')`).run().lastInsertRowid);
  const r = await fetch(`${base}/api/admin/people/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ tlc_user_id: '!!' }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /AHGfamily user id/);
  assert.doesNotMatch(body.error, /\bTLC\b/);
  // importer header error names the portal too
  const roster = require('../server/lib/rosterImport');
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['nope'], ['x', 'y']]), 'S');
  assert.throws(() => roster.parseWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })), /AHGfamily member export/);
  setEnv('THEME', null);
  assert.equal((await (await fetch(base + '/api/config')).json()).portal.short, 'TLC');
});
