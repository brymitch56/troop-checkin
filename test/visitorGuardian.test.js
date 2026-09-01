'use strict';
// Visitor quick-add: siblings share ONE guardian record (guardian_id
// chaining + email/phone dedupe), bad guardian_id rejected, adults untouched.
// SYNTHETIC DATA ONLY (invented names, 555-xxxx, @example.com).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-visg-'));

const auth = require('../server/auth');
const { db } = require('../server/db');

let server, base, doorCookie;

async function post(url, body) {
  const res = await fetch(base + url, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: doorCookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const guardianCount = () => db.prepare(
  `SELECT COUNT(*) c FROM person WHERE is_youth = 0 AND status != 'merged'`).get().c;

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door V', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await (await fetch(base + '/api/staff-list')).json());
  doorCookie = (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staff[0].id, pin: '1234' }),
  })).headers.get('set-cookie').split(';')[0];
});

after(() => server && server.close());

test('first youth creates the parent; response carries guardian_id + name', async () => {
  const r = await post('/api/visitor', {
    is_youth: true, first_name: 'Ivy', last_name: 'Visitor',
    guardian_name: 'Vera Visitor', guardian_phone: '555-0301', guardian_email: 'Vera.Visitor@example.com',
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.guardian_id);
  assert.equal(r.json.guardian_name, 'Vera Visitor');
  assert.equal(guardianCount(), 1);
});

test('sibling via guardian_id: no parent fields needed, ONE guardian, two links', async () => {
  const gid = db.prepare(`SELECT id FROM person WHERE first_name = 'Vera'`).get().id;
  const r = await post('/api/visitor', {
    is_youth: true, first_name: 'Ike', last_name: 'Visitor', guardian_id: gid,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.guardian_id, gid);
  assert.equal(guardianCount(), 1);
  const links = db.prepare(
    `SELECT youth_id, authorized, is_primary FROM person_guardian WHERE guardian_id = ?`).all(gid);
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.authorized === 1 && l.is_primary === 1));
});

test('dedupe: re-typed parent with same email (any case/spacing) reuses the record', async () => {
  const before = guardianCount();
  const r = await post('/api/visitor', {
    is_youth: true, first_name: 'Iris', last_name: 'Visitor',
    guardian_name: 'Vera Visitor', guardian_phone: '(555) 0301', guardian_email: '  vera.visitor@EXAMPLE.com ',
  });
  assert.equal(r.status, 200);
  assert.equal(guardianCount(), before); // no new parent row
  assert.equal(db.prepare('SELECT COUNT(*) c FROM person_guardian WHERE guardian_id = ?')
    .get(r.json.guardian_id).c, 3);
});

test('dedupe by phone digits when the email differs but the phone matches', async () => {
  const before = guardianCount();
  const r = await post('/api/visitor', {
    is_youth: true, first_name: 'Ian', last_name: 'Visitor',
    guardian_name: 'Vera Visitor', guardian_phone: '555.0301', guardian_email: 'other.address@example.com',
  });
  assert.equal(r.status, 200);
  assert.equal(guardianCount(), before);
});

test('a different parent still gets a new record (no over-merging)', async () => {
  const before = guardianCount();
  const r = await post('/api/visitor', {
    is_youth: true, first_name: 'Owen', last_name: 'Other',
    guardian_name: 'Olive Other', guardian_phone: '555-0399', guardian_email: 'olive.other@example.com',
  });
  assert.equal(r.status, 200);
  assert.equal(guardianCount(), before + 1);
});

test('bad guardian_id (youth, merged, or missing) → 400; adults never link', async () => {
  const youthId = db.prepare(`SELECT id FROM person WHERE first_name = 'Ivy'`).get().id;
  assert.equal((await post('/api/visitor', {
    is_youth: true, first_name: 'X', last_name: 'Y', guardian_id: youthId })).status, 400);
  assert.equal((await post('/api/visitor', {
    is_youth: true, first_name: 'X', last_name: 'Y', guardian_id: 999999 })).status, 400);
  const merged = Number(db.prepare(
    `INSERT INTO person (is_youth, first_name, last_name, status) VALUES (0, 'Gone', 'Guardian', 'merged')`
  ).run().lastInsertRowid);
  assert.equal((await post('/api/visitor', {
    is_youth: true, first_name: 'X', last_name: 'Y', guardian_id: merged })).status, 400);
  // adult visitor: name only, no guardian, guardian_id null
  const a = await post('/api/visitor', { is_youth: false, first_name: 'Al', last_name: 'Adultvisitor' });
  assert.equal(a.status, 200);
  assert.equal(a.json.guardian_id, null);
  // youth without any parent info still refused (rule unchanged)
  assert.equal((await post('/api/visitor', { is_youth: true, first_name: 'No', last_name: 'Parent' })).status, 400);
});

// --------------------------------------- merge: unregistered into unregistered ----
test('merge tool: duplicate unregistered parents merge into each other; merged target refused', async () => {
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin V', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  const staff = await (await fetch(base + '/api/staff-list')).json();
  const adminCookie = (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staff.find((s) => s.role === 'admin').id, pin: 'adminpass' }),
  })).headers.get('set-cookie').split(';')[0];
  const adminPost = async (url, body) => {
    const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  // two pre-fix duplicate parents (neither on the roster), each linked to a youth
  const dup1 = Number(db.prepare(`INSERT INTO person (is_youth, first_name, last_name, phone_mobile, status) VALUES (0, 'Dee', 'Duplicate', '555-0350', 'active')`).run().lastInsertRowid);
  const dup2 = Number(db.prepare(`INSERT INTO person (is_youth, first_name, last_name, email, status) VALUES (0, 'Dee', 'Duplicate', 'dee.duplicate@example.com', 'active')`).run().lastInsertRowid);
  const kidA = Number(db.prepare(`INSERT INTO person (is_youth, first_name, last_name, status) VALUES (1, 'Ava', 'Duplicate', 'visitor')`).run().lastInsertRowid);
  const kidB = Number(db.prepare(`INSERT INTO person (is_youth, first_name, last_name, status) VALUES (1, 'Bo', 'Duplicate', 'visitor')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO person_guardian (youth_id, guardian_id, authorized, is_primary, source) VALUES (?, ?, 1, 1, 'manual')`).run(kidA, dup1);
  db.prepare(`INSERT INTO person_guardian (youth_id, guardian_id, authorized, is_primary, source) VALUES (?, ?, 1, 1, 'manual')`).run(kidB, dup2);

  // the picker's candidate list now includes unregistered adults (with phone for the confirm text)
  const cands = await (await fetch(base + '/api/admin/people?type=adult&q=Duplicate', { headers: { cookie: adminCookie } })).json();
  assert.ok(cands.some((c) => c.id === dup2 && !c.member_id));
  assert.ok('phone_mobile' in cands[0]);

  const m = await adminPost('/api/admin/merge', { from_id: dup2, into_id: dup1 });
  assert.equal(m.status, 200);
  assert.equal(db.prepare('SELECT status, merged_into_id FROM person WHERE id = ?').get(dup2).status, 'merged');
  const links = db.prepare('SELECT youth_id FROM person_guardian WHERE guardian_id = ? ORDER BY youth_id').all(dup1);
  assert.deepEqual(links.map((l) => l.youth_id), [kidA, kidB]); // both kids now on the survivor

  // merging INTO the retired record is refused
  const dup3 = Number(db.prepare(`INSERT INTO person (is_youth, first_name, last_name, status) VALUES (0, 'Dee', 'Duplicate', 'active')`).run().lastInsertRowid);
  const bad = await adminPost('/api/admin/merge', { from_id: dup3, into_id: dup2 });
  assert.equal(bad.status, 409);
});
