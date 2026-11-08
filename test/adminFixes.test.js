'use strict';
// Admin fixes (v0.4.75, migration 021):
//   - Admin → Transactions "Move to another event": a finished visit (sign-in
//     AND sign-out) re-filed under the right event, with the attendance push
//     following it
//   - dismissing failed pushes that will never land (non-members)
//   - events that the kiosk never auto-selects (overlaps)
//   - the push's "needs a sign-in code" pause clears itself once the stored
//     portal session is proven good again
// Synthetic roster; invented people only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-adminfix-'));
process.env.CRED_KEY = require('crypto').randomBytes(32).toString('hex');

const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const roster = require('../server/lib/rosterImport');
const auth = require('../server/auth');
const { db } = require('../server/db');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let server, base, door, admin;
let n = 0;
const uuid = () => `af-${++n}`;
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
// linked to a (fake) portal event so the attendance push queues for it
const mkEvent = (title, tlcId, { startMin = -60, endMin = 120, autoSelect = 1 } = {}) => Number(db.prepare(
  `INSERT INTO event (source, title, start_at, end_at, track_adults, tlc_event_id, auto_select)
   VALUES ('manual', ?, datetime('now', ?), datetime('now', ?), 0, ?, ?)`)
  .run(title, `${startMin} minutes`, `${endMin} minutes`, tlcId, autoSelect).lastInsertRowid);
const txnBody = (direction, eventId, people) => ({
  client_uuid: uuid(), direction, event_id: eventId, entries: people.map((p) => ({ person_id: p.id })),
  signer_person_id: person('Bob').id, signature_data: PNG, force: true,
});
const signIn = (eventId, people) => req('POST', '/api/txn', { cookie: door, body: txnBody('in', eventId, people) });
const signOut = (eventId, people) => req('POST', '/api/txn', { cookie: door, body: txnBody('out', eventId, people) });
const attendees = (eventId) => require('../server/routes/integration').attendanceFor(
  db.prepare('SELECT * FROM event WHERE id = ?').get(eventId)).map((a) => a.person_id).sort();
const pushRow = (eventId, pid) => db.prepare('SELECT * FROM tlc_attendance_push WHERE event_id = ? AND person_id = ?').get(eventId, pid);

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin AF', 'admin', ?)`).run(auth.hashSecret('pw'));
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door AF', 'door', ?)`).run(auth.hashSecret('1234'));
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(people, roster.suggestLinks(people), null, 'seed.xlsx', null);
  require('../server/lib/attendanceSync').saveSettings({ enabled: 1 });
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login(1, 'pw');
  door = await login(2, '1234');
});
after(() => server && server.close());

test('move: a finished group visit moves whole — sign-in, sign-out, attendance and push', async () => {
  const wrong = mkEvent('Side Event', 'fakeevt00001');
  const right = mkEvent('Weekly Meeting', 'fakeevt00002');
  const kids = [person('Danny'), person('Emma')];
  const inR = await signIn(wrong, kids);
  assert.equal(inR.status, 200, JSON.stringify(inR.json));
  const outR = await signOut(wrong, kids);
  assert.equal(outR.status, 200, JSON.stringify(outR.json));
  assert.deepEqual(attendees(wrong), kids.map((k) => k.id).sort());
  for (const k of kids) assert.ok(pushRow(wrong, k.id), 'sign-out queued a push for the wrong event');
  // one of them was already marked on the portal: that cannot be undone here
  db.prepare("UPDATE tlc_attendance_push SET status = 'sent' WHERE event_id = ? AND person_id = ?").run(wrong, kids[1].id);

  const srcIn = db.prepare('SELECT * FROM txn WHERE id = ?').get(inR.json.txn_id);
  const r = await req('POST', `/api/admin/txns/${inR.json.txn_id}/move`, { cookie: admin, body: { event_id: right } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.moved, 2);

  assert.deepEqual(attendees(wrong), [], 'nobody left at the wrong event');
  assert.deepEqual(attendees(right), kids.map((k) => k.id).sort(), 'both at the right event');
  const att = require('../server/routes/integration').attendanceFor(db.prepare('SELECT * FROM event WHERE id = ?').get(right));
  assert.ok(att.every((a) => a.signed_out_at), 'the sign-outs moved too');
  const newIn = db.prepare('SELECT * FROM txn WHERE id = ?').get(r.json.results[0].in_txn_id);
  assert.equal(newIn.signed_at, srcIn.signed_at, 'original arrival time');
  assert.equal(newIn.signature_path, srcIn.signature_path, 'original signature');
  assert.ok(db.prepare('SELECT voided_by_txn_id v FROM txn WHERE id = ?').get(srcIn.id).v, 'the emptied source sign-in is voided');
  assert.ok(db.prepare('SELECT voided_by_txn_id v FROM txn WHERE id = ?').get(outR.json.txn_id).v, 'the emptied source sign-out is voided');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM txn_correction WHERE kind = 'move'").get().c, 4, 'in + out per person');

  // push: the unsent row is gone, the sent one is reported, both queued for the right event
  assert.equal(pushRow(wrong, kids[0].id), undefined);
  assert.equal(pushRow(wrong, kids[1].id).status, 'sent');
  assert.equal(r.json.results.find((x) => x.person_id === kids[1].id).push.already_sent, true);
  for (const k of kids) assert.equal(pushRow(right, k.id).status, 'pending');
});

test('move: one person out of a group leaves the others and the source txn alone', async () => {
  const wrong = mkEvent('Side Event 2', 'fakeevt00003');
  const right = mkEvent('Weekly Meeting 2', 'fakeevt00004');
  const kids = [person('Frank'), person('Danny')];
  const inR = await signIn(wrong, kids);
  assert.equal(inR.status, 200, JSON.stringify(inR.json));
  const r = await req('POST', `/api/admin/txns/${inR.json.txn_id}/move`,
    { cookie: admin, body: { event_id: right, person_ids: [kids[0].id] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.results[0].open, true, 'still on site');
  assert.deepEqual(attendees(wrong), [kids[1].id]);
  assert.deepEqual(attendees(right), [kids[0].id]);
  assert.equal(db.prepare('SELECT voided_by_txn_id v FROM txn WHERE id = ?').get(inR.json.txn_id).v, null);
  assert.equal(pushRow(right, kids[0].id), undefined, 'still on site: the push queues at sign-out, not now');
});

test('move: refused when they already have a sign-in at the target', async () => {
  const a = mkEvent('Overlap A', 'fakeevt00005');
  const b = mkEvent('Overlap B', 'fakeevt00006');
  const kid = person('Emma');
  await signOut(null, [kid]).catch(() => {}); // clear any earlier open visit
  const first = await signIn(a, [kid]);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  await signOut(a, [kid]);
  const second = await signIn(b, [kid]);
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const r = await req('POST', `/api/admin/txns/${first.json.txn_id}/move`, { cookie: admin, body: { event_id: b } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already has a sign-in/);
});

test('dismiss: a failed push leaves the failed count and Retry failed, and can be restored', async () => {
  const sync = require('../server/lib/attendanceSync');
  const ev = mkEvent('Dismiss Event', 'fakeevt00007');
  const pid = person('Bob').id;
  const id = Number(db.prepare(
    `INSERT INTO tlc_attendance_push (event_id, person_id, tlc_event_id, status, detail)
     VALUES (?, ?, 'fakeevt00007', 'failed', 'No portal roster entry matches.')`).run(ev, pid).lastInsertRowid);
  const before = sync.queueSummary().failed;
  const r = await req('POST', '/api/admin/tlc-attendance/dismiss', { cookie: admin, body: { ids: [id], note: 'not a member' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.dismissed, 1);
  assert.equal(sync.queueSummary().failed, before - 1);
  assert.equal(sync.queueSummary().dismissed, 1);
  sync.retryFailed();
  assert.equal(db.prepare('SELECT status FROM tlc_attendance_push WHERE id = ?').get(id).status, 'failed', 'retry skips it');
  const log = await req('GET', '/api/admin/push-log?status=dismissed', { cookie: admin });
  assert.equal(log.json.length, 1);
  assert.equal(log.json[0].dismiss_note, 'not a member');
  assert.equal(log.json[0].dismissed_by_name, 'Admin AF');
  // pending rows cannot be dismissed
  db.prepare("UPDATE tlc_attendance_push SET status = 'pending' WHERE event_id = ? AND person_id = ?").run(ev, pid);
  assert.equal(sync.dismissFailed([id], 1).dismissed, 0);
  db.prepare("UPDATE tlc_attendance_push SET status = 'failed' WHERE id = ?").run(id);
  await req('POST', `/api/admin/tlc-attendance/${id}/undismiss`, { cookie: admin, body: {} });
  assert.equal(db.prepare('SELECT dismissed_at FROM tlc_attendance_push WHERE id = ?').get(id).dismissed_at, null);
});

test('auto-select: a pick-by-hand event is listed as current but never suggested', async () => {
  db.prepare('DELETE FROM tlc_attendance_push').run();
  db.prepare('DELETE FROM txn_correction').run();
  db.prepare('DELETE FROM txn_person').run();
  db.prepare('DELETE FROM txn').run();
  db.prepare('DELETE FROM event').run();
  // the side event's start is nearest now, so it used to win the suggestion
  const main = mkEvent('Weekly Meeting', null, { startMin: -45, endMin: 60 });
  const side = mkEvent('Side Conference', null, { startMin: 5, endMin: 75, autoSelect: 0 });
  let r = await req('GET', '/api/events/current', { cookie: door });
  assert.deepEqual(r.json.matching.map((e) => e.id).sort(), [main, side].sort());
  assert.equal(r.json.suggested_id, main);
  // with only the pick-by-hand event current, nothing is suggested
  db.prepare('DELETE FROM event WHERE id = ?').run(main);
  r = await req('GET', '/api/events/current', { cookie: door });
  assert.equal(r.json.suggested_id, null);
  // the admin editor sets and clears it
  const p = await req('PATCH', `/api/admin/events/${side}`, { cookie: admin, body: { auto_select: true } });
  assert.equal(p.json.auto_select, 1);
});

test('code pause: clears itself once the stored portal session has worked since', async () => {
  const sync = require('../server/lib/attendanceSync');
  const ps = require('../server/lib/portalSession');
  const STATE = 'tlc_attendance_state';
  const setState = (o) => db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(STATE, JSON.stringify({ ...sync.getState(), ...o }));
  ps.saveCookies({ map: new Map([['session', 'fake-cookie-never-real']]) }, 'https://portal.example.com');
  // paused AFTER the session last worked: still a real pause
  setState({ code_required_at: new Date(Date.now() + 60000).toISOString() });
  assert.equal(sync.codeLatchStale(), false);
  let r = await sync.runPush();
  assert.match(r.reason, /sign-in code/);
  // the session works again after the pause (another job used it)
  setState({ code_required_at: new Date(Date.now() - 3600000).toISOString() });
  ps.touch();
  assert.equal(sync.codeLatchStale(), true);
  r = await sync.runPush();
  assert.equal(r.reason, 'Nothing pending.', 'past the pause');
  assert.equal(sync.getState().code_required_at, null);
});
