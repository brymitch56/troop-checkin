'use strict';
// The contract between node-ical and server/lib/icalSync.js, run through the
// REAL parser. Every other test hands applyFeed() hand-made objects, so a
// node-ical upgrade that changed how a date or a text property comes back
// would pass the whole suite and only show up in production.
//
// Why it matters: a feed event's identity is `uid | start ISO instant`. If a
// parser change moved a start by even an hour, every event would look new and
// the old rows would be deleted (or flagged, if anyone had signed in).
// node-ical is 0.x and breaks freely between minors — bump it, run this.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-icalparse-'));
require('../server/migrate');
const ical = require('node-ical');
const { db } = require('../server/db');
const { applyFeed } = require('../server/lib/icalSync');

const VTIMEZONE = `BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

const vevent = (uid, lines) => `BEGIN:VEVENT
UID:${uid}@example.com
DTSTAMP:20260901T120000Z
${lines}
END:VEVENT`;

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//troop-checkin//parse contract//EN
X-WR-TIMEZONE:America/New_York
${VTIMEZONE}
${vevent('utc', `DTSTART:20261006T223000Z
DTEND:20261007T000000Z
SUMMARY:Weekly Meeting
LOCATION:Fellowship Hall
DESCRIPTION:Bring a water bottle`)}
${vevent('tzid-daylight', `DTSTART;TZID=America/New_York:20261013T183000
DTEND;TZID=America/New_York:20261013T200000
SUMMARY:Weekly Meeting`)}
${vevent('tzid-standard', `DTSTART;TZID=America/New_York:20261208T183000
DTEND;TZID=America/New_York:20261208T200000
SUMMARY:Weekly Meeting`)}
${vevent('fall-back-hour', `DTSTART;TZID=America/New_York:20261101T013000
DTEND;TZID=America/New_York:20261101T030000
SUMMARY:Early Hike`)}
${vevent('floating', `DTSTART:20261020T183000
DTEND:20261020T200000
SUMMARY:Weekly Meeting`)}
${vevent('windows-tzid', `DTSTART;TZID=Eastern Standard Time:20261124T183000
DTEND;TZID=Eastern Standard Time:20261124T200000
SUMMARY:Weekly Meeting`)}
${vevent('duration', `DTSTART;TZID=America/New_York:20261103T183000
DURATION:PT1H30M
SUMMARY:Weekly Meeting`)}
${vevent('no-dtend', `DTSTART;TZID=America/New_York:20261027T183000
SUMMARY:Weekly Meeting`)}
${vevent('all-day', `DTSTART;VALUE=DATE:20261017
DTEND;VALUE=DATE:20261018
SUMMARY:Day Hike`)}
${vevent('all-day-weekend', `DTSTART;VALUE=DATE:20261113
DTEND;VALUE=DATE:20261116
SUMMARY:Fall Campout`)}
${vevent('folded', `DTSTART:20261117T233000Z
DTEND:20261118T010000Z
SUMMARY:A long title that the feed has folded across two physical lines bec
 ause it runs past seventy-five octets`)}
${vevent('escaped', `DTSTART:20261118T233000Z
DTEND:20261119T010000Z
SUMMARY:Pack\\, carry\\; repeat
DESCRIPTION:Line one\\nLine two`)}
${vevent('with-params', `DTSTART:20261110T233000Z
DTEND:20261111T010000Z
SUMMARY;LANGUAGE=en-US:Court of Honor
LOCATION;LANGUAGE=en-US:Main Hall
DESCRIPTION;ALTREP="cid:part1@example.com":Families welcome`)}
END:VCALENDAR
`;

const parsed = ical.sync.parseICS(ICS);
const ev = (uid) => Object.values(parsed).find((e) => e.type === 'VEVENT' && e.uid === `${uid}@example.com`);
const instant = (d) => new Date(d).toISOString();
const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('every VEVENT survives the sync filter (type, uid, start, end)', () => {
  const kept = Object.values(parsed).filter((e) => e.type === 'VEVENT' && e.uid && e.start && e.end);
  assert.equal(kept.length, 13);
});

test('timed events resolve to the same instant whatever the server timezone', () => {
  // [uid, start, end] — 18:30 Eastern is 22:30Z in daylight time, 23:30Z in standard
  const expected = [
    ['utc', '2026-10-06T22:30:00.000Z', '2026-10-07T00:00:00.000Z'],
    ['tzid-daylight', '2026-10-13T22:30:00.000Z', '2026-10-14T00:00:00.000Z'],
    ['tzid-standard', '2026-12-08T23:30:00.000Z', '2026-12-09T01:00:00.000Z'],
    ['fall-back-hour', '2026-11-01T06:30:00.000Z', '2026-11-01T08:00:00.000Z'],
    ['floating', '2026-10-20T22:30:00.000Z', '2026-10-21T00:00:00.000Z'], // X-WR-TIMEZONE applies
    ['windows-tzid', '2026-11-24T23:30:00.000Z', '2026-11-25T01:00:00.000Z'],
    ['duration', '2026-11-03T23:30:00.000Z', '2026-11-04T01:00:00.000Z'], // end = start + DURATION
    ['no-dtend', '2026-10-27T22:30:00.000Z', '2026-10-27T22:30:00.000Z'], // end defaults to start
  ];
  for (const [uid, start, end] of expected) {
    const e = ev(uid);
    assert.equal(e.datetype, 'date-time', `${uid}: datetype`);
    assert.equal(instant(e.start), start, `${uid}: start`);
    assert.equal(instant(e.end), end, `${uid}: end`);
  }
});

test('all-day events are flagged datetype "date" and land on the right local day', () => {
  // all-day dates are local midnight, so assert the calendar day, not the instant
  assert.equal(ev('all-day').datetype, 'date');
  assert.equal(localYmd(ev('all-day').start), '2026-10-17');
  assert.equal(localYmd(ev('all-day').end), '2026-10-18');
  assert.equal(ev('all-day-weekend').datetype, 'date');
  assert.equal(localYmd(ev('all-day-weekend').start), '2026-11-13');
  assert.equal(localYmd(ev('all-day-weekend').end), '2026-11-16'); // DTEND is exclusive
});

test('plain text properties come back as strings, unfolded and unescaped', () => {
  assert.equal(ev('utc').summary, 'Weekly Meeting');
  assert.equal(ev('utc').location, 'Fellowship Hall');
  assert.equal(ev('utc').description, 'Bring a water bottle');
  assert.equal(ev('folded').summary,
    'A long title that the feed has folded across two physical lines because it runs past seventy-five octets');
  assert.equal(ev('escaped').summary, 'Pack, carry; repeat');
  assert.equal(ev('escaped').description, 'Line one\nLine two');
});

test('a text property carrying a parameter parses to { params, val } — and the sync stores val', () => {
  const e = ev('with-params');
  assert.equal(typeof e.summary, 'object', 'if this is a string now, icalSync.text() is merely redundant');
  assert.equal(e.summary.val, 'Court of Honor');

  // this used to throw ("Too few parameter values") and roll back the whole sync
  const r = applyFeed([e]);
  assert.equal(r.added, 1);
  const row = db.prepare('SELECT title, location, description FROM event WHERE ical_uid = ?').get(e.uid);
  assert.deepEqual({ ...row }, { title: 'Court of Honor', location: 'Main Hall', description: 'Families welcome' });

  assert.equal(applyFeed([e]).updated, 0, 'a second identical sync must see no change');
});

test('the whole parsed feed syncs, and syncing it again changes nothing', () => {
  const feed = Object.values(parsed).filter((x) => x.type === 'VEVENT' && x.uid && x.start && x.end);
  const first = applyFeed(feed);
  assert.equal(first.feed_events, 13);
  assert.equal(first.added + first.updated, 12, 'with-params is already there from the test above');
  const again = applyFeed(feed);
  assert.deepEqual(
    { added: again.added, updated: again.updated, flagged: again.flagged, deleted: again.deleted },
    { added: 0, updated: 0, flagged: 0, deleted: 0 });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM event WHERE source = 'ical' AND all_day = 1`).get().n, 2);
});
