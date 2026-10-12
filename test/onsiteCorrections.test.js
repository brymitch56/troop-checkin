'use strict';
// On-site corrections across concurrent events (lib/onsiteCorrections,
// migration 019): move a sign-in to the right event, also sign into a second
// one (linked: one sign-out closes both), leave one of two linked sign-ins.
// Synthetic roster; invented people only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-onsite-'));

const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const roster = require('../server/lib/rosterImport');
const auth = require('../server/auth');
const { db } = require('../server/db');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let server, base, door, admin;
let n = 0;
const uuid = () => `oc-${++n}`;
const person = (first) => db.prepare('SELECT * FROM person WHERE first_name = ?').get(first);
async function req(method, url, { body, cookie } = {}) {
  const headers = { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const login = async (staffId, pin) => (await fetch(base + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staff_id: staffId, pin }),
})).headers.get('set-cookie').split(';')[0];
const mkEvent = (title, { adults = 0, form = 0, block = 0 } = {}) => Number(db.prepare(
  `INSERT INTO event (source, title, start_at, end_at, track_adults, requires_permission_form, permission_block)
   VALUES ('manual', ?, datetime('now','-1 hour'), datetime('now','+2 hours'), ?, ?, ?)`).run(title, adults, form, block).lastInsertRowid);
const mkYouth = (first) => db.prepare("INSERT INTO person (is_youth, first_name, last_name, patrol, status) VALUES (1, ?, 'Testkid', 'Hawks', 'active') RETURNING *").get(first);
const opens = (pid) => db.prepare(
  `SELECT t.event_id, tp.txn_id FROM txn_person tp JOIN txn t ON t.id = tp.txn_id
    WHERE tp.person_id = ? AND tp.open = 1 AND t.voided_by_txn_id IS NULL ORDER BY t.event_id`).all(pid);
const signIn = (eventId, people, extra = {}) => req('POST', '/api/txn', { cookie: door, body: {
  client_uuid: uuid(), direction: 'in', event_id: eventId, entries: people.map((p) => ({ person_id: p.id })),
  signer_person_id: person('Bob').id, signature_data: PNG, force: true, ...extra,
} });
const signOut = (eventId, people) => req('POST', '/api/txn', { cookie: door, body: {
  client_uuid: uuid(), direction: 'out', ...(eventId ? { event_id: eventId } : {}),
  entries: people.map((p) => ({ person_id: p.id })),
  signer_person_id: person('Bob').id, signature_data: PNG, force: true,
} });

let A, B, groupTxn;
before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin OC', 'admin', ?)`).run(auth.hashSecret('pw'));
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door OC', 'door', ?)`).run(auth.hashSecret('1234'));
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(people, roster.suggestLinks(people), null, 'seed.xlsx', null);
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login(1, 'pw');
  door = await login(2, '1234');
  A = mkEvent('Meeting A');
  B = mkEvent('Campout B');
  // one GROUP sign-in for three youth, into the wrong event
  const r = await signIn(A, [person('Danny'), person('Emma'), person('Frank')]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  groupTxn = r.json.txn_id;
});
after(() => server && server.close());

test('options: the open sign-in, and the other current events to move or copy it to', async () => {
  const r = await req('GET', `/api/onsite/${person('Danny').id}/options`, { cookie: door });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.opens.map((o) => o.event_id), [A]);
  assert.ok(r.json.targets.some((t) => t.id === B && t.allowed));
  assert.ok(!r.json.targets.some((t) => t.id === A), 'never the event they are already in');
  // the On-site list carries the sign-in id the kiosk needs
  const on = await req('GET', '/api/onsite', { cookie: door });
  assert.equal(on.json.find((x) => x.id === person('Danny').id).in_txn_id, groupTxn);
});

test('move: one youth leaves the group sign-in for the right event; the others are untouched', async () => {
  const danny = person('Danny');
  const before = db.prepare('SELECT * FROM txn WHERE id = ?').get(groupTxn);
  const r = await req('POST', `/api/onsite/${danny.id}/move`, { cookie: door, body: { in_txn_id: groupTxn, event_id: B } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(opens(danny.id).map((o) => o.event_id), [B]);
  const moved = db.prepare('SELECT * FROM txn WHERE id = ?').get(r.json.txn_id);
  assert.equal(moved.signed_at, before.signed_at, 'the original arrival time');
  assert.equal(moved.signer_person_id, before.signer_person_id, 'the same signer');
  assert.equal(moved.signature_path, before.signature_path, 'the same signature');
  for (const first of ['Emma', 'Frank']) {
    assert.deepEqual(opens(person(first).id), [{ event_id: A, txn_id: groupTxn }], `${first} still on the group sign-in`);
  }
  assert.equal(db.prepare('SELECT voided_by_txn_id FROM txn WHERE id = ?').get(groupTxn).voided_by_txn_id, null, 'no whole-txn void');
  const log = db.prepare("SELECT * FROM txn_correction WHERE kind = 'move' AND person_id = ?").get(danny.id);
  assert.deepEqual([log.from_txn_id, log.to_txn_id], [groupTxn, r.json.txn_id]);
  assert.ok(log.staff_id, 'who did it');
});

test('guard rails: same event, already there, gone, adults at a youth-only event', async () => {
  const emma = person('Emma');
  assert.equal((await req('POST', `/api/onsite/${emma.id}/move`, { cookie: door, body: { in_txn_id: groupTxn, event_id: A } })).status, 400);
  assert.equal((await req('POST', `/api/onsite/${emma.id}/move`, { cookie: door, body: { in_txn_id: 999999, event_id: B } })).status, 409);
  // an adult signed into an adult-tracked event cannot be moved to one that isn't
  const C = mkEvent('Adult Training C', { adults: 1 });
  const alice = person('Alice');
  const s = await req('POST', '/api/txn', { cookie: door, body: { client_uuid: uuid(), direction: 'in', event_id: C, entries: [{ person_id: alice.id }] } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const opt = await req('GET', `/api/onsite/${alice.id}/options`, { cookie: door });
  assert.equal(opt.json.targets.find((t) => t.id === B).allowed, false, 'shown as not allowed up front');
  const bad = await req('POST', `/api/onsite/${alice.id}/move`, { cookie: door, body: { in_txn_id: s.json.txn_id, event_id: B } });
  assert.equal(bad.status, 422);
  assert.match(bad.json.error, /does not track adult/);
});

test('copy: also signed into the other event — linked; one kiosk sign-out closes both, recording each event', async () => {
  const emma = person('Emma');
  const r = await req('POST', `/api/onsite/${emma.id}/copy`, { cookie: door, body: { in_txn_id: groupTxn, event_id: B } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(opens(emma.id).map((o) => o.event_id), [A, B]);
  const opt = await req('GET', `/api/onsite/${emma.id}/options`, { cookie: door });
  assert.ok(opt.json.opens.every((o) => o.linked), 'both shown as linked');
  // a second copy into an event she is already in is refused
  assert.equal((await req('POST', `/api/onsite/${emma.id}/copy`, { cookie: door, body: { in_txn_id: groupTxn, event_id: B } })).status, 409);
  // the kiosk has NO event hint matching (or none at all): linked opens are one stay, not a question
  const out = await signOut(null, [emma]);
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.equal(out.json.linked_closed, 1);
  assert.deepEqual(opens(emma.id), [], 'signed out of both');
  const outs = db.prepare(
    `SELECT t.event_id, t.signer_person_id, t.close_method FROM txn_person tp JOIN txn t ON t.id = tp.txn_id
      WHERE tp.person_id = ? AND t.direction = 'out' ORDER BY t.event_id`).all(emma.id);
  assert.deepEqual(outs.map((o) => o.event_id), [A, B], 'a sign-out recorded in each event');
  assert.ok(outs.every((o) => o.close_method === 'signature' && o.signer_person_id === person('Bob').id));
});

test('two INDEPENDENT sign-ins (made by hand) still ask which event to sign out of', async () => {
  const gina = mkYouth('Gina');
  assert.equal((await signIn(A, [gina])).status, 200);
  assert.equal((await signIn(B, [gina], { allow_multi: true })).status, 200);
  const out = await signOut(null, [gina]);
  assert.equal(out.status, 409, 'unchanged behaviour: not linked, so the kiosk must pick');
  assert.match(out.json.error, /more than one event/);
  assert.equal((await signOut(A, [gina])).status, 200);
  assert.deepEqual(opens(gina.id).map((o) => o.event_id), [B], 'only the chosen one closed');
});

test('remove: leave one of two linked sign-ins (group sign-in stays for everyone else); never the last one', async () => {
  const frank = person('Frank');
  const c = await req('POST', `/api/onsite/${frank.id}/copy`, { cookie: door, body: { in_txn_id: groupTxn, event_id: B } });
  assert.equal(c.status, 200);
  // leave A (the group sign-in): only Frank's row goes; the txn and its others stay
  const r = await req('POST', `/api/onsite/${frank.id}/remove`, { cookie: door, body: { in_txn_id: groupTxn } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(opens(frank.id).map((o) => o.event_id), [B]);
  assert.equal(db.prepare('SELECT voided_by_txn_id FROM txn WHERE id = ?').get(groupTxn).voided_by_txn_id, null);
  // now B is his only sign-in: removing it is refused (that would erase attendance)
  const last = await req('POST', `/api/onsite/${frank.id}/remove`, { cookie: door, body: { in_txn_id: c.json.txn_id } });
  assert.equal(last.status, 409);
  assert.match(last.json.error, /only sign-in/);
});

test('remove on a single-person copy voids it (append-only); admin close-open also closes linked sign-ins', async () => {
  const kid = mkYouth('Kid' + (++n));
  const s = await signIn(A, [kid]);
  const c1 = await req('POST', `/api/onsite/${kid.id}/copy`, { cookie: door, body: { in_txn_id: s.json.txn_id, event_id: B } });
  const rm = await req('POST', `/api/onsite/${kid.id}/remove`, { cookie: door, body: { in_txn_id: c1.json.txn_id } });
  assert.equal(rm.status, 200);
  assert.equal(rm.json.voided_txn_id, c1.json.txn_id, 'the copy was voided');
  assert.deepEqual(opens(kid.id).map((o) => o.event_id), [A]);
  // link again, then an admin close (no guardian present) closes both
  await req('POST', `/api/onsite/${kid.id}/copy`, { cookie: door, body: { in_txn_id: s.json.txn_id, event_id: B } });
  const close = await req('POST', '/api/admin/close-open', { cookie: admin, body: { person_id: kid.id } });
  assert.equal(close.status, 200, JSON.stringify(close.json));
  assert.equal(close.json.linked_closed, 1);
  assert.deepEqual(opens(kid.id), []);
});

test('permission-form soft block applies to the target event; staff can override (recorded)', async () => {
  db.prepare(`INSERT INTO meta (key, value) VALUES ('permission_forms', '{"enabled":1,"block_default":0}')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  const D = mkEvent('Hike D (form required)', { form: 1, block: 1 });
  const kid = mkYouth('Kid' + (++n));
  const s = await signIn(A, [kid]);
  const no = await req('POST', `/api/onsite/${kid.id}/move`, { cookie: door, body: { in_txn_id: s.json.txn_id, event_id: D } });
  assert.equal(no.status, 422, JSON.stringify(no.json));
  assert.ok(Array.isArray(no.json.permission_unsigned), 'names who, for the kiosk prompt');
  const yes = await req('POST', `/api/onsite/${kid.id}/move`, { cookie: door, body: { in_txn_id: s.json.txn_id, event_id: D, force_permission: true } });
  assert.equal(yes.status, 200);
  assert.equal(db.prepare('SELECT permission_override FROM txn WHERE id = ?').get(yes.json.txn_id).permission_override, 1);
});
