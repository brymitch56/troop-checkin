'use strict';
// A unit can subscribe to several calendar feeds (its own plus area, region,
// national). They must be merged and applied as one: applying them one at a
// time reads each feed's events as "gone" from the others.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-icalmulti-'));
require('../server/migrate');
const { db } = require('../server/db');
const { syncIcal } = require('../server/lib/icalSync');

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const inDays = (n) => new Date(Date.now() + n * 86400000);
const vevent = (uid, start, title = 'Weekly Meeting', modified = new Date()) => [
  'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(new Date())}`, `LAST-MODIFIED:${stamp(modified)}`,
  `SUMMARY:${title}`, `DTSTART:${stamp(start)}`,
  `DTEND:${stamp(new Date(start.getTime() + 2 * 3600000))}`, 'END:VEVENT',
].join('\r\n');
const calendar = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');

const feeds = { unit: '', area: '', broken: null };
let server, base;
before(async () => {
  server = http.createServer((req, res) => {
    const name = req.url.slice(1);
    if (feeds[name] == null) { res.statusCode = 500; return res.end('nope'); }
    res.setHeader('Content-Type', 'text/calendar'); res.end(feeds[name]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const titles = () => db.prepare(`SELECT title FROM event WHERE source = 'ical' AND removed_from_feed = 0 ORDER BY title`)
  .all().map((r) => r.title);

const unitEvents = () => [
  vevent('FAKEHEADX-evfake000041-20260101T000000', inDays(3), 'Unit Meeting'),
  vevent('FAKEHEADX-evfake000042-20260101T000000', inDays(10), 'Unit Campout'),
];

test('two feeds are merged into one calendar, and neither deletes the other', async () => {
  feeds.unit = calendar(unitEvents());
  feeds.area = calendar([vevent('FAKEHEADX-evfake000043-20260101T000000', inDays(5), 'Area Challenge')]);
  const r = await syncIcal(`${base}/unit ${base}/area`);
  assert.equal(r.added, 3);
  assert.deepEqual(r.feeds, [2, 1]);
  const again = await syncIcal(`${base}/unit,${base}/area`);
  assert.deepEqual({ added: again.added, deleted: again.deleted, flagged: again.flagged }, { added: 0, deleted: 0, flagged: 0 });
  assert.deepEqual(titles(), ['Area Challenge', 'Unit Campout', 'Unit Meeting']);
});

test('an event listed in two feeds becomes one row, taking the most recently edited copy', async () => {
  const start = inDays(5);
  feeds.area = calendar([
    vevent('FAKEHEADX-evfake000043-20260101T000000', start, 'Area Challenge'),
    vevent('FAKEHEADX-evfake000041-20250101T000000', inDays(3), 'Unit Meeting (stale)', new Date('2025-01-01')),
  ]);
  feeds.unit = calendar([
    vevent('FAKEHEADX-evfake000041-20260601T000000', inDays(3), 'Unit Meeting', new Date('2026-06-01')),
    vevent('FAKEHEADX-evfake000042-20260101T000000', inDays(10), 'Unit Campout'),
  ]);
  await syncIcal([`${base}/unit`, `${base}/area`]);
  assert.deepEqual(titles(), ['Area Challenge', 'Unit Campout', 'Unit Meeting']);
});

test('a feed that fails to load changes nothing', async () => {
  const before = titles();
  await assert.rejects(syncIcal(`${base}/unit ${base}/broken`), (e) => {
    assert.match(e.message, /feed 2 of 2 could not be loaded/);
    assert.doesNotMatch(e.message, /127\.0\.0\.1/, 'the feed URL (a private token) is never echoed');
    return true;
  });
  assert.deepEqual(titles(), before);
});

test('one feed going empty is refused while upcoming events are listed', async () => {
  feeds.area = calendar([vevent('FAKEHEADX-evfake000043-20260101T000000', inDays(5), 'Area Challenge')]);
  await syncIcal(`${base}/unit ${base}/area`);
  feeds.area = calendar([]);
  await assert.rejects(syncIcal(`${base}/unit ${base}/area`), /no events \(feed 2 of 2\)/);
  assert.deepEqual(titles(), ['Area Challenge', 'Unit Campout', 'Unit Meeting']);
});

test('events only in an extra feed start hidden; a sync never changes hidden afterwards', async () => {
  const hidden = () => Object.fromEntries(db.prepare(`SELECT title, hidden FROM event WHERE source = 'ical'`)
    .all().map((r) => [r.title, r.hidden]));
  assert.deepEqual(hidden(), { 'Area Challenge': 1, 'Unit Campout': 0, 'Unit Meeting': 0 },
    'the copy of Unit Meeting in the area feed did not hide it — it is also in the first feed');
  // the admin shows the area event and hides a unit one
  db.prepare(`UPDATE event SET hidden = 0 WHERE title = 'Area Challenge'`).run();
  db.prepare(`UPDATE event SET hidden = 1 WHERE title = 'Unit Campout'`).run();
  feeds.area = calendar([vevent('FAKEHEADX-evfake000043-20260301T000000', inDays(6), 'Area Challenge (moved)')]);
  feeds.unit = calendar(unitEvents());
  await syncIcal(`${base}/unit ${base}/area`);
  assert.deepEqual(hidden(), { 'Area Challenge (moved)': 0, 'Unit Campout': 1, 'Unit Meeting': 0 },
    'an edit in the portal keeps the admin choice');
});

test('hidden events stay off the kiosk list; admin sees them and can toggle', async () => {
  const auth = require('../server/auth');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin T', 'admin', ?)`).run(auth.hashSecret('pw'));
  const app = require('../server/index');
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const root = `http://127.0.0.1:${srv.address().port}`;
  try {
    const login = await fetch(`${root}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staff_id: 1, pin: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = (p) => fetch(root + p, { headers: { cookie } }).then((r) => r.json());
    const kiosk = async () => { const b = await get('/api/events/current'); return [...b.matching, ...b.upcoming].map((e) => e.title); };

    let out = await kiosk();
    assert.ok(!out.includes('Unit Campout'), 'hidden event is not offered at the door');
    assert.ok(out.includes('Unit Meeting'));
    const admin = await get('/api/admin/events');
    const campout = admin.find((e) => e.title === 'Unit Campout');
    assert.equal(campout.hidden, 1, 'admin list still has it, flagged');

    const res = await fetch(`${root}/api/admin/events/${campout.id}`, { method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ hidden: false }) });
    assert.equal(res.status, 200);
    out = await kiosk();
    assert.ok(out.includes('Unit Campout'), 'shown again after the admin un-hides it');
  } finally { srv.close(); }
});
