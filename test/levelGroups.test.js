'use strict';
// Level groups (public/level-groups.js + lib/levelGroups.js): combined levels
// like "PiPa" or "Woodlands" in every level filter, program order in every
// level sort, and the Level column in the attendance reports.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-levels-'));

const LG = require('../public/level-groups');
const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const roster = require('../server/lib/rosterImport');
const auth = require('../server/auth');
const { db } = require('../server/db');

let server, base, adminCookie, doorCookie;
const youth = {}; // level -> person id

async function req(method, url, { body, cookie } = {}) {
  const headers = cookie ? { cookie } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, json, text };
}

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin L', 'admin', ?)`)
    .run(auth.hashSecret('pw'));
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door L', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(people, roster.suggestLinks(people), null, 'seed.xlsx', null);

  // the synthetic roster's three youth at three levels, all signed in to one event
  const ids = db.prepare(`SELECT id FROM person WHERE is_youth = 1 AND status = 'active' ORDER BY id LIMIT 3`).all();
  const levels = ['Pioneer', 'Patriot', 'Explorer'];
  db.prepare(`UPDATE person SET level = NULL WHERE is_youth = 1`).run();
  ids.forEach((r, i) => {
    db.prepare('UPDATE person SET level = ? WHERE id = ?').run(levels[i], r.id);
    youth[levels[i]] = r.id;
  });
  const ev = db.prepare(`INSERT INTO event (title, start_at, end_at) VALUES ('Weekly Meeting', ?, ?)`)
    .run(new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 3600e3).toISOString());
  ids.forEach((r, i) => {
    const t = db.prepare(`INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id)
                          VALUES (?, ?, 'in', ?, 2)`).run(`lvl-${i}`, ev.lastInsertRowid, new Date().toISOString());
    db.prepare('INSERT INTO txn_person (txn_id, person_id, open) VALUES (?, ?, 1)').run(t.lastInsertRowid, r.id);
  });

  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (id, pin) => {
    const res = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staff_id: id, pin }),
    });
    return res.headers.get('set-cookie').split(';')[0];
  };
  adminCookie = await login(1, 'pw');
  doorCookie = await login(2, '1234');
});

after(() => server && server.close());

const AHG = 'Tenderheart\nExplorer\nPiPa = Pioneer, Patriot\nPathfinder';

test('parse: levels, groups and program order; format round-trips', () => {
  const r = LG.parse(AHG);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.order, ['Tenderheart', 'Explorer', 'Pioneer', 'Patriot', 'Pathfinder']);
  assert.deepEqual(r.groups, [{ name: 'PiPa', levels: ['Pioneer', 'Patriot'] }]);
  assert.equal(LG.format(r), AHG);
  const tl = LG.parse('Woodlands = Fox, Hawk, Mountain Lion\nNav/Adv = Navigator, Adventurer');
  assert.deepEqual(tl.errors, []);
  assert.deepEqual(tl.groups.map((g) => g.name), ['Woodlands', 'Nav/Adv']);
  assert.deepEqual(LG.parse('').order, []);
});

test('parse: a level in two places, a one-level group, or a nameless group is an error', () => {
  assert.equal(LG.parse('A = Fox, Hawk\nB = Hawk, Navigator').errors.length, 1);
  assert.equal(LG.parse('Fox\nWoodlands = Fox, Hawk').errors.length, 1);
  assert.equal(LG.parse('Solo = Fox').errors.length, 1);
  assert.equal(LG.parse(' = Fox, Hawk').errors.length, 1);
  assert.equal(LG.parse('Fox = Fox, Hawk').errors.length, 1); // group named like a level
});

test('matcher: group expands, program order sorts, blanks last, options nest', () => {
  const m = LG.create(LG.parse(AHG));
  assert.deepEqual(m.expand('pipa'), ['Pioneer', 'Patriot']);
  assert.deepEqual(m.expand('Explorer'), ['Explorer']);
  assert.equal(m.expand(''), null);
  assert.ok(m.matches('Patriot', 'PiPa') && !m.matches('Explorer', 'PiPa'));
  assert.ok(m.matches(null, '') && !m.matches(null, 'PiPa'));
  assert.deepEqual(['Pioneer', '', 'Zebra', 'Patriot', 'Tenderheart', 'Explorer'].sort(m.compare),
    ['Tenderheart', 'Explorer', 'Pioneer', 'Patriot', 'Zebra', '']);
  assert.deepEqual(m.options(['Patriot', 'Explorer', 'Pioneer']).map((o) => o.value),
    ['Explorer', 'PiPa', 'Pioneer', 'Patriot']);
  // no config = exact match, alphabetical — the pre-groups behavior
  const none = LG.create(null);
  assert.ok(none.matches('Patriot', 'Patriot') && !none.matches('Patriot', 'PiPa'));
  assert.deepEqual(['Pioneer', 'Patriot'].sort(none.compare), ['Patriot', 'Pioneer']);
});

test('save: admin only; a bad list is refused whole', async () => {
  assert.equal((await req('PUT', '/api/admin/level-groups', { cookie: doorCookie, body: { text: AHG } })).status, 403);
  const bad = await req('PUT', '/api/admin/level-groups', { cookie: adminCookie, body: { text: 'PiPa = Pioneer' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /at least two levels/);
  assert.equal((await req('GET', '/api/level-groups', { cookie: doorCookie })).json.groups.length, 0);
  const ok = await req('PUT', '/api/admin/level-groups', { cookie: adminCookie, body: { text: AHG } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.groups, [{ name: 'PiPa', levels: ['Pioneer', 'Patriot'] }]);
});

test('kiosk: /levels in program order, /onsite and snapshot honor the group', async () => {
  await req('PUT', '/api/admin/level-groups', { cookie: adminCookie, body: { text: AHG } });
  const levels = (await req('GET', '/api/levels', { cookie: doorCookie })).json;
  assert.deepEqual(levels, ['Explorer', 'Pioneer', 'Patriot']); // program order, not A–Z
  const pipa = (await req('GET', '/api/onsite?level=PiPa', { cookie: doorCookie })).json;
  assert.deepEqual(pipa.map((r) => r.id).sort(), [youth.Pioneer, youth.Patriot].sort());
  const one = (await req('GET', '/api/onsite?level=Patriot', { cookie: doorCookie })).json;
  assert.deepEqual(one.map((r) => r.id), [youth.Patriot]);
  const snap = (await req('GET', '/api/roster-snapshot', { cookie: doorCookie })).json;
  assert.deepEqual(snap.level_groups.groups.map((g) => g.name), ['PiPa']);
});

test('reports: Level column in the summary + CSVs, level filter takes a group', async () => {
  await req('PUT', '/api/admin/level-groups', { cookie: adminCookie, body: { text: AHG } });
  const all = (await req('GET', '/api/admin/report/summary', { cookie: adminCookie })).json;
  assert.equal(all.find((r) => r.id === youth.Explorer).level, 'Explorer');
  const pipa = (await req('GET', '/api/admin/report/summary?level=PiPa', { cookie: adminCookie })).json;
  assert.deepEqual(pipa.map((r) => r.id).sort(), [youth.Pioneer, youth.Patriot].sort());
  const csv = (await req('GET', '/api/admin/export/summary.csv?level=PiPa', { cookie: adminCookie })).text;
  const lines = csv.trim().split(/\r?\n/);
  assert.match(lines[0], /^last_name,first_name,type,patrol,level,events_attended/);
  assert.equal(lines.length, 3);
  const detail = (await req('GET', '/api/admin/export/attendance.csv?level=Explorer', { cookie: adminCookie })).text;
  assert.match(detail.split(/\r?\n/)[0], /,patrol,level,direction,/);
  assert.equal(detail.trim().split(/\r?\n/).length, 2);
});
