'use strict';
// Roster import parser + apply rules, against a synthetic TLC export.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// isolate the DB before any app module loads
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-roster-'));

const { buildWorkbookBuffer, DEFAULT_ROWS } = require('../server/scripts/make-synthetic-roster');
const roster = require('../server/lib/rosterImport');
const { db } = require('../server/db');

before(() => { require('../server/migrate'); });

test('parseWorkbook: finds header row, skips title/junk rows', () => {
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  assert.equal(people.length, 6); // 3 adults + 3 youth, junk row skipped
  assert.equal(people.filter((p) => p.is_youth).length, 3);
});

test('parseWorkbook: youth Email is a TLC username, not an email', () => {
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  const danny = people.find((p) => p.first_name === 'Danny');
  assert.equal(danny.email, null);
  assert.equal(danny.tlc_username, 'danny.a.tlc');
  const alice = people.find((p) => p.first_name === 'Alice');
  assert.equal(alice.email, 'alice.anderson@example.com');
  assert.equal(alice.tlc_username, null);
});

test('parseWorkbook: rejects a non-TLC workbook', () => {
  const XLSX = require('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([['Name', 'Phone'], ['X', 'Y']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  assert.throws(() => roster.parseWorkbook(buf), /Member Number/);
});

test('suggestLinks: cc-email, last-name, and address fallbacks all link', () => {
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  const links = roster.suggestLinks(people);
  const nameOf = (i) => people[i].first_name;
  const bySource = (s) => links.filter((l) => l.source === s);
  // Danny -> Alice via cc email
  const email = bySource('import_email');
  assert.equal(email.length, 1);
  assert.equal(nameOf(email[0].youth), 'Danny');
  assert.equal(nameOf(email[0].adult), 'Alice');
  // Emma -> Bob (last name), Frank -> Carol (address+zip)
  const fb = bySource('import_address');
  assert.deepEqual(
    fb.map((l) => [nameOf(l.youth), nameOf(l.adult)]).sort(),
    [['Emma', 'Bob'], ['Frank', 'Carol']]
  );
});

test('applyImport: adds everyone, links guardians, records the import', () => {
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  const links = roster.suggestLinks(people);
  const r = roster.applyImport(people, links, null, 'synthetic.xlsx', null);
  assert.equal(r.added, 6);
  assert.equal(r.updated, 0);
  assert.equal(r.deactivated, 0);
  assert.equal(r.linked_guardians, 3);
  const emma = db.prepare(`SELECT * FROM person WHERE first_name = 'Emma'`).get();
  const g = db.prepare(
    `SELECT g.first_name FROM person_guardian pg JOIN person g ON g.id = pg.guardian_id
      WHERE pg.youth_id = ?`).all(emma.id);
  assert.deepEqual(g.map((x) => x.first_name), ['Bob']);
});

test('re-import: idempotent, never blanks fields with empty cells', () => {
  // second import of same file: nothing added/updated/deactivated, no dup links
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  const r = roster.applyImport(people, roster.suggestLinks(people), null, 'synthetic.xlsx', null);
  assert.deepEqual(
    [r.added, r.updated, r.deactivated, r.linked_guardians], [0, 0, 0, 0]);

  // an update with an emptied patrol cell must NOT blank the stored patrol
  const rows = DEFAULT_ROWS.map((row) => [...row]);
  const danny = rows.find((row) => row[2] === 'Danny');
  danny[6] = '';        // Patrol emptied
  danny[3] = 'Danno';   // Nickname changed
  const people2 = roster.parseWorkbook(buildWorkbookBuffer(rows));
  const r2 = roster.applyImport(people2, [], null, 'synthetic2.xlsx', null);
  assert.equal(r2.updated, 1);
  const d = db.prepare(`SELECT * FROM person WHERE member_id = 'Y-2001'`).get();
  assert.equal(d.nickname, 'Danno');
  assert.equal(d.patrol, 'Eagles'); // preserved
});

test('deactivation: scoped to classes present in the file, reactivates returners', () => {
  // youth-only file omitting Emma: Emma deactivated, adults untouched
  const youthOnly = DEFAULT_ROWS.filter((row) => row[4] === 'Y' && row[2] !== 'Emma');
  const people = roster.parseWorkbook(buildWorkbookBuffer(youthOnly));
  const prev = roster.computePreview(people);
  assert.deepEqual(prev.deactivate.map((d) => d.first_name), ['Emma']);
  roster.applyImport(people, [], null, 'youth-only.xlsx', null);
  assert.equal(db.prepare(`SELECT status FROM person WHERE member_id = 'Y-2002'`).get().status, 'inactive');
  assert.equal(db.prepare(`SELECT status FROM person WHERE member_id = 'A-1001'`).get().status, 'active');

  // full re-import brings Emma back
  const all = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(all, [], null, 'full.xlsx', null);
  assert.equal(db.prepare(`SELECT status FROM person WHERE member_id = 'Y-2002'`).get().status, 'active');
});

test('manual guardian links are never duplicated by import', () => {
  const emma = db.prepare(`SELECT id FROM person WHERE member_id = 'Y-2002'`).get();
  const carol = db.prepare(`SELECT id FROM person WHERE member_id = 'A-1003'`).get();
  db.prepare(`INSERT INTO person_guardian (youth_id, guardian_id, authorized, is_primary, source)
              VALUES (?, ?, 1, 0, 'manual')`).run(emma.id, carol.id);
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  const links = roster.suggestLinks(people);
  const r = roster.applyImport(people, links, null, 'again.xlsx', null);
  assert.equal(r.linked_guardians, 0);
  const cnt = db.prepare(`SELECT COUNT(*) c FROM person_guardian WHERE youth_id = ?`).get(emma.id).c;
  assert.equal(cnt, 2); // Bob (import) + Carol (manual), no dups
});
