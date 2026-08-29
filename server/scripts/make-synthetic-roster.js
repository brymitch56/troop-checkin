'use strict';
// Generates a synthetic Trail Life Connect member-export .xlsx for testing.
// Mirrors the real export shape (see server/lib/rosterImport.js): title row,
// header row found by "Member Number", Youth Y/N flag, youth "Email" is a TLC
// username, guardian cc-email / last-name / address linkage. FAKE NAMES ONLY.
const XLSX = require('xlsx');

const HEADERS = ['Member Number', 'Last Name', 'First Name', 'Nickname', 'Youth',
  'Role', 'Patrol', 'Current Level', 'Email', 'Adult Cc Email',
  'Mobile Phone', 'Home Phone', 'Work Phone', 'Birthdate',
  'Address Line 1', 'Zip', 'Membership Exp.', 'Health Form', 'High Risk Form'];

// "Membership Exp." arrives as a formatted string (US M/D/YYYY in the real
// export). Emma's is dynamic — always ~20 days out — so the kiosk expiry
// warning is exercisable in tests regardless of when they run.
const usDate = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const soonExp = () => usDate(new Date(Date.now() + 20 * 86400000));
const farExp = () => usDate(new Date(Date.now() + 400 * 86400000));
// "Health Form" holds the SUBMISSION date (valid 12 months). Dynamic values:
// Alice's is ~350 days old (expires within 30 days), Danny's is fresh.
const daysAgo = (n) => usDate(new Date(Date.now() - n * 86400000));

// Three fake families exercising each guardian-link path:
//   Anderson — youth cc-email matches adult email    (import_email)
//   Brown    — no cc-email, same last name           (import_address fallback)
//   Miller   — no cc-email, different last name, same address (import_address fallback)
const DEFAULT_ROWS = [
  // adults (registered adults carry member numbers; Bob is unregistered)
  ['A-1001', 'Anderson', 'Alice', '', 'N', 'Troop Leader', '', '', 'alice.anderson@example.com', '', '555-0101', '', '', '1985-03-04', '12 Oak St', '14850', farExp(), daysAgo(350), ''],
  ['',       'Brown',    'Bob',   '', 'N', '',             '', '', 'bob.brown@example.com',      '', '555-0102', '', '', '1982-07-15', '77 Maple Rd', '14850', '', '', ''],
  ['A-1003', 'Clark',    'Carol', '', 'N', 'Committee',    '', '', 'carol.clark@example.com',    '', '555-0103', '', '', '1979-11-30', '34 Pine Ave', '14850', farExp(), '', ''],
  // youth (youth "Email" is a TLC username, not an email)
  ['Y-2001', 'Anderson', 'Danny', 'Dan', 'Y', '', 'Eagles', 'Navigators', 'danny.a.tlc', 'alice.anderson@example.com', '', '555-0201', '', '2012-05-20', '12 Oak St', '14850', farExp(), daysAgo(30), ''],
  ['Y-2002', 'Brown',    'Emma',  '',    'Y', '', 'Hawks',  'Adventurers', 'emma.b.tlc',  '',                          '', '', '', '2013-09-02', '77 Maple Rd', '14850', soonExp(), '', ''],
  ['Y-2003', 'Miller',   'Frank', '',    'Y', '', 'Eagles', 'Navigators', 'frank.m.tlc', '',                          '', '', '', '2011-01-11', '34 Pine Ave', '14850', '', '', ''],
];

function buildWorkbookBuffer(rows = DEFAULT_ROWS) {
  const aoa = [
    ['Troop NY-0000 Member Export (SYNTHETIC TEST DATA)'], // title row above headers
    [],
    HEADERS,
    ...rows,
    ['', 'Section: junk row that must be skipped'], // no Y/N flag -> ignored
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Members');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildWorkbookBuffer, DEFAULT_ROWS, HEADERS, usDate };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const out = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'synthetic-roster.xlsx');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildWorkbookBuffer());
  console.log(`wrote ${out}`);
}
