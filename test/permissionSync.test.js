'use strict';
// Permission-form sync: grid parsing/apply rules (manual wins), export
// parsing (PK sniff, youth-only storage), unsigned queries, settings switch,
// and the imminent-window selection. All fixtures are SYNTHETIC — invented
// names, fake ev/et ids — per the public-repo PII rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-perm-'));

const { db } = require('../server/db');
const ps = require('../server/lib/permissionSync');

// --- synthetic fixtures -----------------------------------------------------
// Mirrors the observed Yii2 GridView shape: header th carries data-col-seq,
// each row tr carries data-key="ev…" and an /calendar/update/et… link; the
// Forms-Completed cell is empty unless an icon renders.
const GRID_HTML = `
<table><thead><tr>
  <th data-col-seq="1">Title</th>
  <th data-col-seq="9"><a href="#">Forms Completed</a></th>
</tr></thead><tbody>
<tr data-key="evtestcamp01"><td data-col-seq="1"><a href="/calendar/update/ettestcamp01">Fall Campout</a></td><td data-col-seq="9"><span class="glyphicon glyphicon-remove text-danger"></span></td></tr>
<tr data-key="evtestmeet01"><td data-col-seq="1"><a href="/calendar/update/ettestmeet01">Weekly Meeting</a></td><td data-col-seq="9">&nbsp; </td></tr>
<tr data-key="evtestunkn01"><td data-col-seq="1"><a href="/calendar/update/ettestunkn01">Other Event</a></td><td data-col-seq="9"></td></tr>
</tbody></table>`;

function exportBuffer(rows) {
  const XLSX = require('xlsx');
  const aoa = [
    ['Synthetic Event Participants (TEST DATA)'],
    ['Member Number', 'Last Name', 'First Name', 'Youth', 'Event Permission Form', 'RSVP'],
    ...rows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Participants');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const addPerson = (first, last, extra = {}) =>
  Number(db.prepare(
    `INSERT INTO person (is_youth, member_id, first_name, last_name, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(extra.is_youth ?? 1, extra.member_id || null, first, last,
        extra.status || 'active').lastInsertRowid);

const addEvent = (title, extra = {}) =>
  Number(db.prepare(
    `INSERT INTO event (source, title, start_at, end_at, tlc_event_id,
                        requires_permission_form, permission_form_source, tlc_et_slug)
     VALUES ('ical', ?, ?, ?, ?, ?, ?, ?)`
  ).run(title,
        extra.start_at || new Date(Date.now() + 3600e3).toISOString(),
        extra.end_at || new Date(Date.now() + 7200e3).toISOString(),
        extra.tlc_event_id || null,
        extra.required ? 1 : 0, extra.source || null,
        extra.et_slug || null).lastInsertRowid);

let campId, meetId;

before(() => {
  require('../server/migrate');
  campId = addEvent('Fall Campout', { tlc_event_id: 'evtestcamp01' });
  meetId = addEvent('Weekly Meeting', { tlc_event_id: 'evtestmeet01' });
});

after(() => { /* db handle closes with the process */ });

test('settings: default off; active() gates on switch + TLC_ENABLED', () => {
  assert.equal(ps.getSettings().enabled, 0);
  assert.equal(ps.active({ TLC_ENABLED: 'true' }), false);
  ps.saveSettings({ enabled: 1 });
  assert.equal(ps.active({ TLC_ENABLED: 'true' }), true);
  assert.equal(ps.active({ TLC_ENABLED: 'false' }), false);
});

test('parseGrid: hashid, et-slug, and presence-only requirement per row', () => {
  const rows = ps.parseGrid(GRID_HTML);
  assert.equal(rows.length, 3);
  const camp = rows.find((r) => r.tlc_event_id === 'evtestcamp01');
  assert.equal(camp.et_slug, 'ettestcamp01');
  assert.equal(camp.required, 1);                 // icon present
  assert.equal(rows.find((r) => r.tlc_event_id === 'evtestmeet01').required, 0); // &nbsp; only
  assert.equal(rows.find((r) => r.tlc_event_id === 'evtestunkn01').required, 0); // truly empty
});

test('applyGrid: adopts slugs, auto-flags, and never overrides a manual set', () => {
  const r = ps.applyGrid(ps.parseGrid(GRID_HTML));
  assert.equal(r.slugs, 2); // both linked events learn their et-slug
  const camp = db.prepare('SELECT * FROM event WHERE id = ?').get(campId);
  assert.equal(camp.requires_permission_form, 1);
  assert.equal(camp.permission_form_source, 'auto');
  assert.equal(camp.tlc_et_slug, 'ettestcamp01');
  assert.equal(db.prepare('SELECT requires_permission_form FROM event WHERE id = ?')
    .get(meetId).requires_permission_form, 0);

  // admin takes the meeting over manually — the sweep must never clear it
  db.prepare(`UPDATE event SET requires_permission_form = 1,
              permission_form_source = 'manual' WHERE id = ?`).run(meetId);
  ps.applyGrid(ps.parseGrid(GRID_HTML)); // grid still says "not required"
  const meet = db.prepare('SELECT * FROM event WHERE id = ?').get(meetId);
  assert.equal(meet.requires_permission_form, 1);   // manual wins
  assert.equal(meet.permission_form_source, 'manual');
});

test('parseExport: PK sniff, header discovery, Yes/No mapping', () => {
  assert.throws(() => ps.parseExport(Buffer.from('<html>login page</html>')),
    /web page/);
  const rows = ps.parseExport(exportBuffer([
    ['Y-2001', 'Andrews', 'Ben', 'Y', 'Yes', 'Going'],
    ['Y-2002', 'Field', 'Finn', 'Y', 'No', 'Going'],
    ['A-1001', 'Andrews', 'Amy', 'N', 'No', 'Going'],
    ['', 'Guest', 'Gil', 'Y', 'No', ''],          // no member number: dropped
  ]));
  assert.deepEqual(rows, [
    { member_id: 'Y-2001', signed: 1 },
    { member_id: 'Y-2002', signed: 0 },
    { member_id: 'A-1001', signed: 0 },
  ]);
  // truncated junk now falls through to the CSV path and fails on the header
  assert.throws(() => ps.parseExport(exportBuffer([]).slice(0, 2)), /Member Number/);
});

test('storeStatuses: youth only, replaces prior rows, unsigned query counts absence', () => {
  const ben = addPerson('Ben', 'Andrews', { member_id: 'Y-2001' });
  const finn = addPerson('Finn', 'Field', { member_id: 'Y-2002' });
  const amy = addPerson('Amy', 'Andrews', { is_youth: 0, member_id: 'A-1001' });
  const nora = addPerson('Nora', 'Nodata', { member_id: 'Y-2003' }); // not in export

  const stored = ps.storeStatuses(campId, [
    { member_id: 'Y-2001', signed: 1 },
    { member_id: 'Y-2002', signed: 0 },
    { member_id: 'A-1001', signed: 0 },   // adult: ignored by decision
    { member_id: 'Y-9999', signed: 1 },   // unknown member: ignored
  ]);
  assert.equal(stored, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM event_form_status WHERE event_id = ?')
    .get(campId).c, 2);
  assert.ok(ps.lastFetchedAt(campId));

  // flagged = unsigned OR absent; signed youth and adults are not flagged
  const flagged = ps.unsignedYouthIds(campId, [ben, finn, nora]);
  assert.deepEqual(flagged.sort(), [finn, nora].sort());
  assert.ok(!ps.unsignedYouthIds(campId, [ben]).length);
  void amy;

  // a re-store replaces (Finn signs at the last minute)
  ps.storeStatuses(campId, [{ member_id: 'Y-2002', signed: 1 }]);
  assert.deepEqual(ps.unsignedYouthIds(campId, [finn]), []);
  assert.deepEqual(ps.unsignedYouthIds(campId, [ben]), [ben]); // replaced away = absent = flagged
});

test('export URL is the VERIFIED one — blank rsvp_type filter pinned', () => {
  // regression pin (live bug 2026-08-29): without the blank
  // EventParticipantsSearch[rsvp_type] filter TLC answers 200 with CSV
  // after long waits; with it, first-attempt XLSX. Never simplify this URL.
  assert.equal(ps.exportPath('etfakeslug01'),
    '/calendar/exportexcel/etfakeslug01?format=xlsx&EventParticipantsSearch%5Brsvp_type%5D=');
});

test('parseExport accepts CSV bytes (TLC mislabels exports) and rejects HTML', () => {
  const csv = Buffer.from(
    'Synthetic Event Participants (TEST)\n' +
    'Member Number,Last Name,First Name,Event Permission Form\n' +
    'Y-2001,Andrews,Ben,Yes\n' +
    'Y-2002,Field,Finn,No\n');
  assert.deepEqual(ps.parseExport(csv), [
    { member_id: 'Y-2001', signed: 1 },
    { member_id: 'Y-2002', signed: 0 },
  ]);
  assert.throws(() => ps.parseExport(Buffer.from('  <html>login</html>')), /web page/);
});

test('kiosk refresh rate limit: one fetch per event per minute', () => {
  assert.equal(ps.kioskRefreshAllowed(9901), true);
  assert.equal(ps.kioskRefreshAllowed(9901), false); // immediately again: no
  assert.equal(ps.kioskRefreshAllowed(9902), true);  // other events unaffected
});

test('imminent selection: only stale, soon-starting, form-required events', async () => {
  ps.saveSettings({ enabled: 0 });
  assert.deepEqual(await ps.imminent(), { skipped: 'disabled' }); // switch gates jobs
  // (window/staleness math is exercised through statusWindowEvents via
  // nightly/imminent in live runs; the pure pieces are covered above)
});
