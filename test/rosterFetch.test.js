'use strict';
// Unit tests for the TLC roster fetcher — everything testable WITHOUT network
// access: cookie jar semantics, Yii2 CSRF extraction, byte-level format
// sniffing, and every branch of the sanity check including the row-count
// guard. All roster content is synthetic (obviously fake people).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fetch-'));

const XLSX = require('xlsx');
const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const F = require('../server/scripts/fetch-roster');

// ------------------------------------------------------------ cookie jar ---
test('CookieJar: set, overwrite, and render the Cookie header', () => {
  const jar = new F.CookieJar();
  jar.absorbLines(['a=1; Path=/; HttpOnly', 'b=2; Path=/']);
  jar.absorbLines(['a=99; Path=/']); // last write wins
  assert.equal(jar.header(), 'a=99; b=2');
  assert.equal(jar.size, 2);
});

test('CookieJar: deletion via empty value, Max-Age=0, and past Expires', () => {
  const jar = new F.CookieJar();
  jar.absorbLines(['sess=abc; Path=/', 'gone1=x', 'gone2=y', 'gone3=z']);
  jar.absorbLines([
    'gone1=; Path=/',                                       // empty value
    'gone2=whatever; Max-Age=0; Path=/',                    // max-age zero
    'gone3=whatever; Expires=Thu, 01 Jan 1970 00:00:00 GMT', // classic epoch delete
  ]);
  assert.equal(jar.header(), 'sess=abc');
});

test('CookieJar: past Expires other than 1970 also deletes; future keeps', () => {
  const jar = new F.CookieJar();
  jar.absorbLines(['old=x; Expires=Sat, 01 Jan 2005 00:00:00 GMT']);
  jar.absorbLines(['new=y; Expires=Fri, 01 Jan 2100 00:00:00 GMT']);
  assert.equal(jar.header(), 'new=y');
});

test('CookieJar: values containing = are kept whole; junk lines ignored', () => {
  const jar = new F.CookieJar();
  jar.absorbLines(['tok=abc=def==; Path=/', 'no-equals-sign', '']);
  assert.equal(jar.header(), 'tok=abc=def==');
});

// ------------------------------------------------------------------ csrf ---
const TOKEN = 'AbC123_' + 'x'.repeat(80); // 88-ish chars like the real one

test('csrfFrom: meta tag, both attribute orders', () => {
  assert.equal(F.csrfFrom(`<head><meta name="csrf-token" content="${TOKEN}"></head>`), TOKEN);
  assert.equal(F.csrfFrom(`<meta content="${TOKEN}" name="csrf-token">`), TOKEN);
});

test('csrfFrom: hidden form field, both attribute orders', () => {
  assert.equal(F.csrfFrom(`<form><input type="hidden" name="_csrf" value="${TOKEN}"></form>`), TOKEN);
  assert.equal(F.csrfFrom(`<input type="hidden" value="${TOKEN}" name="_csrf">`), TOKEN);
});

test('csrfFrom: meta tag wins over the form field; entities decoded; null when absent', () => {
  const html = `<meta name="csrf-token" content="META"><input name="_csrf" value="FORM">`;
  assert.equal(F.csrfFrom(html), 'META');
  assert.equal(F.csrfFrom(`<meta name="csrf-token" content="a&amp;b&quot;c">`), 'a&b"c');
  assert.equal(F.csrfFrom('<html><body>no token here</body></html>'), null);
});

// --------------------------------------------------------- format sniffing --
test('detectFormat: xlsx magic bytes, HTML error pages, CSV fallthrough', () => {
  assert.equal(F.detectFormat(buildWorkbookBuffer()), 'xlsx'); // real zip: PK\x03\x04
  assert.equal(F.detectFormat(Buffer.from('PK\x03\x04junk')), 'xlsx');
  assert.equal(F.detectFormat(Buffer.from('<!DOCTYPE html><html>login</html>')), 'html');
  assert.equal(F.detectFormat(Buffer.from('\n  <html lang="en">')), 'html');
  assert.equal(F.detectFormat(Buffer.from('﻿<!doctype html>')), 'html'); // BOM
  assert.equal(F.detectFormat(Buffer.from('Member Number,Last Name\nY-1,Fake')), 'csv');
});

// ---------------------------------------------------------- sanity check ---
const expectFail = (fn, code, re) => {
  try { fn(); assert.fail('expected FetchError'); }
  catch (e) {
    assert.ok(e instanceof F.FetchError, `expected FetchError, got ${e}`);
    assert.equal(e.code, code);
    assert.match(e.message, re);
  }
};

test('sanityCheck: rejects tiny files and HTML pages', () => {
  expectFail(() => F.sanityCheck(Buffer.from('short')), 4, /bytes/);
  expectFail(() => F.sanityCheck(Buffer.from('<!doctype html>' + 'x'.repeat(600))), 4, /HTML/);
});

test('sanityCheck: accepts the synthetic xlsx and counts data rows', () => {
  const { rows, format } = F.sanityCheck(buildWorkbookBuffer());
  assert.equal(format, 'xlsx');
  assert.equal(rows, 7); // 6 fake people + 1 junk section row below the header
});

test('sanityCheck: xlsx without a "Member Number" header is rejected', () => {
  const ws = XLSX.utils.aoa_to_sheet([['Name', 'Phone'], ...Array.from({ length: 30 },
    (_, i) => [`Fake Person ${i}`, '555-0100'])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  expectFail(() => F.sanityCheck(buf), 4, /Member Number/);
});

test('sanityCheck: fewer than 5 data rows is rejected', () => {
  // long title string keeps the workbook comfortably above the 512-byte floor
  // so this test exercises the row-count branch, not the size branch
  const ws = XLSX.utils.aoa_to_sheet([
    ['Synthetic tiny export — '.repeat(40)],
    ['Member Number', 'Last Name', 'First Name', 'Youth'],
    ['Y-1', 'Fake', 'Alice', 'Y'], ['Y-2', 'Fake', 'Bob', 'Y'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  assert.ok(buf.length >= 512, 'fixture must clear the size floor');
  expectFail(() => F.sanityCheck(buf), 4, /Only 2 data rows/);
});

test('sanityCheck: CSV branch counts rows and honors the header scan', () => {
  const lines = ['Some Title Banner', 'Member Number,Last Name,First Name,Youth'];
  for (let i = 0; i < 20; i++) lines.push(`Y-${i},Fake,Person${i},Y`);
  const buf = Buffer.from(lines.join('\r\n').padEnd(600, '\n'));
  const { rows, format } = F.sanityCheck(buf);
  assert.equal(format, 'csv');
  assert.equal(rows, 20);
  expectFail(() => F.sanityCheck(Buffer.from('a,b,c\n'.repeat(200))), 4, /Member Number/);
});

test('sanityCheck row guard: >20% drop refused, smaller drop and growth pass', () => {
  const buf = buildWorkbookBuffer(); // 7 data rows
  // previous fetch had 113 rows -> 7 is a catastrophic drop
  expectFail(() => F.sanityCheck(buf, { prevRows: 113, rowTolerance: 0.2 }), 4, /dropped from 113 to 7/);
  // within tolerance: 7 vs previous 8 is a ~12% drop
  assert.equal(F.sanityCheck(buf, { prevRows: 8, rowTolerance: 0.2 }).rows, 7);
  // growth is always fine
  assert.equal(F.sanityCheck(buf, { prevRows: 5, rowTolerance: 0.2 }).rows, 7);
  // no previous state: guard is skipped (first ever run)
  assert.equal(F.sanityCheck(buf, { prevRows: null, rowTolerance: 0.2 }).rows, 7);
});

test('sanityCheck row guard: tolerance is configurable (spec: keep it strict but tunable)', () => {
  const buf = buildWorkbookBuffer(); // 7 rows
  // ultra-strict: even a 1-row drop refuses
  expectFail(() => F.sanityCheck(buf, { prevRows: 8, rowTolerance: 0.05 }), 4, /dropped/);
  // loose (resolved-filter-question world): a big drop is allowed through
  assert.equal(F.sanityCheck(buf, { prevRows: 113, rowTolerance: 0.95 }).rows, 7);
});

test('makeConfig: defaults are the safe ones', () => {
  const cfg = F.makeConfig({ DATA_DIR: '/tmp/x' });
  assert.equal(cfg.exportPath, '/user/index?export=xlsx&new=0'); // xlsx, not csv
  assert.equal(cfg.rowTolerance, 0.2);
  assert.equal(cfg.enabled, true);
  const off = F.makeConfig({ TLC_ENABLED: 'false', DATA_DIR: '/tmp/x' });
  assert.equal(off.enabled, false);
  const tuned = F.makeConfig({ TLC_ROW_TOLERANCE: '0.05', DATA_DIR: '/tmp/x' });
  assert.equal(tuned.rowTolerance, 0.05);
});

test('pruneOldExports: removes only files older than the retention window', () => {
  const cfg = F.makeConfig({ DATA_DIR: process.env.DATA_DIR, TLC_RETAIN_DAYS: '56' });
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const oldF = path.join(cfg.outDir, 'roster-old.xlsx');
  const newF = path.join(cfg.outDir, 'roster-new.xlsx');
  fs.writeFileSync(oldF, 'x'); fs.writeFileSync(newF, 'y');
  const old = (Date.now() - 60 * 86400000) / 1000;
  fs.utimesSync(oldF, old, old);
  assert.equal(F.pruneOldExports(cfg), 1);
  assert.ok(!fs.existsSync(oldF));
  assert.ok(fs.existsSync(newF));
});
