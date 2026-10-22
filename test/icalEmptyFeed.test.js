'use strict';
// A portal served one EMPTY (but valid) calendar feed during a change on its
// side. Applied as-is, it read as "every event was cancelled": events without
// sign-ins were deleted and the rest flagged gone from feed. syncIcal must
// refuse an empty feed while upcoming events are listed — and change nothing.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-icalempty-'));
require('../server/migrate');
const { db } = require('../server/db');
const { syncIcal } = require('../server/lib/icalSync');

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const inDays = (n) => new Date(Date.now() + n * 86400000);
const vevent = (uid, start) => [
  'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(new Date())}`, 'SUMMARY:Weekly Meeting',
  `DTSTART:${stamp(start)}`, `DTEND:${stamp(new Date(start.getTime() + 2 * 3600000))}`, 'END:VEVENT',
].join('\r\n');
const calendar = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');

let feed = '';
let server, url;
before(async () => {
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/calendar'); res.end(feed); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/feed.ics`;
});
after(() => server.close());

const counts = () => db.prepare(`SELECT COUNT(*) n, SUM(removed_from_feed) gone FROM event WHERE source = 'ical'`).get();

test('an empty feed is refused while upcoming events are listed, and nothing changes', async () => {
  feed = calendar([
    vevent('FAKEHEADX-evfake000031@ahgfamily.org', inDays(3)),
    vevent('FAKEHEADX-evfake000032@ahgfamily.org', inDays(10)),
  ]);
  assert.equal((await syncIcal(url)).added, 2);
  const lastBefore = db.prepare(`SELECT value FROM meta WHERE key = 'last_ical_sync'`).get().value;

  feed = calendar([]);
  await assert.rejects(syncIcal(url), /no events while 2 upcoming/);
  assert.deepEqual(counts(), { n: 2, gone: 0 }, 'no event deleted or flagged');
  assert.equal(db.prepare(`SELECT value FROM meta WHERE key = 'last_ical_sync'`).get().value, lastBefore,
    'a refused sync is not recorded as a success');

  // the portal recovers: the next sync is ordinary
  feed = calendar([
    vevent('FAKEHEADX-evfake000031@ahgfamily.org', inDays(3)),
    vevent('FAKEHEADX-evfake000032@ahgfamily.org', inDays(10)),
  ]);
  const r = await syncIcal(url);
  assert.deepEqual({ added: r.added, flagged: r.flagged, deleted: r.deleted }, { added: 0, flagged: 0, deleted: 0 });
});

test('with nothing upcoming, an empty feed is still applied (a calendar can genuinely be empty)', async () => {
  db.prepare(`UPDATE event SET start_at = ?, end_at = ? WHERE source = 'ical'`)
    .run(inDays(-30).toISOString(), inDays(-30).toISOString());
  feed = calendar([]);
  const r = await syncIcal(url);
  assert.equal(r.feed_events, 0);
  assert.equal(r.deleted, 2, 'past events with no history are cleaned up as before');
});
