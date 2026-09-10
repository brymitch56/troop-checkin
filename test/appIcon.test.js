'use strict';
// The themed app mark (/icon.svg). Two instances on one server otherwise show
// an identical browser-tab icon; the mark takes the palette's own colors so
// they are told apart at a glance. The traillife render must stay the mark
// the PNG has always been.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-icon-'));

const auth = require('../server/auth');
const { db } = require('../server/db');
const theme = require('../server/lib/theme');

let server, base;
const saved = {};
const setEnv = (k, v) => { if (!(k in saved)) saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; };

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin I', 'admin', ?)`).run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  server && server.close();
});

test('default (traillife) draws the historic mark: pine ground, paper strokes', () => {
  setEnv('THEME', null);
  const svg = theme.iconSvg();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"/);
  assert.match(svg, /fill="#17402C"/);            // --pine, the PNG's ground
  assert.equal((svg.match(/#F4F3EC/g) || []).length, 2); // --paper: box + check
  assert.match(svg, /<\/svg>\n$/);
  // no external references — it has to render as a favicon and offline
  assert.doesNotMatch(svg, /<image|xlink:href|url\(|<script/i);
});

test('THEME=ahg recolors the same geometry (blue ground, no pine left)', () => {
  setEnv('THEME', 'ahg');
  const ahg = theme.iconSvg();
  assert.match(ahg, /fill="#0061AB"/);   // AHG brand blue, PMS 2945
  assert.doesNotMatch(ahg, /#17402C/);

  setEnv('THEME', null);
  const traillife = theme.iconSvg();

  // Same drawing, different paint: with the colors blanked out the two are
  // byte-identical, so a preset can never quietly reshape the mark.
  const geometry = (s) => s.replace(/#[0-9A-F]{6}/g, '#');
  assert.equal(geometry(ahg), geometry(traillife));
  assert.notEqual(ahg, traillife);
});

test('a THEME_PINE override reaches the icon, so a customized install stays consistent', () => {
  setEnv('THEME', 'ahg');
  setEnv('THEME_PINE', '#123456');
  assert.match(theme.iconSvg(), /fill="#123456"/);
  setEnv('THEME_PINE', null);
});

test('GET /icon.svg serves the themed mark as image/svg+xml', async () => {
  setEnv('THEME', null);
  const r = await fetch(base + '/icon.svg');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
  // must not be cached hard: the palette can change without the file changing
  assert.match(r.headers.get('cache-control') || '', /no-cache/);
  const body = await r.text();
  assert.equal(body, theme.iconSvg());
});

test('the manifest offers the themed mark alongside the PNG fallbacks', async () => {
  const m = await (await fetch(base + '/manifest.webmanifest')).json();
  const svg = m.icons.find((i) => i.src === '/icon.svg');
  assert.ok(svg, '/icon.svg is listed');
  assert.equal(svg.type, 'image/svg+xml');
  assert.equal(svg.sizes, 'any');
  // the PNGs stay for iOS home screens and anything that cannot take an SVG
  assert.ok(m.icons.some((i) => i.src === '/icon-512.png'));
});

test('every page that has a favicon link offers the themed one first', () => {
  for (const f of ['index.html', 'admin.html', 'guide.html', 'setup.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" sizes="any" href="\/icon\.svg">/,
      `${f} links the themed icon`);
    // sizes="any" is what makes a browser prefer it over the 192px PNG link
    assert.ok(html.indexOf('/icon.svg') < html.indexOf('/favicon.ico'), `${f} lists it before the .ico fallback`);
  }
});

test('the shell precaches it, so the tab icon survives offline and version bumps', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /'\/icon\.svg'/);
  assert.match(sw, /'\/apple-touch-icon\.png'/);
});

// ------------------------------------------------------------- PNG + meta ---
// iOS home screens take apple-touch-icon, which is PNG-only, and the phone's
// browser chrome takes a <meta> tag — neither can be reached by the SVG or by
// theme.css, so both are covered here.

// Enough of a PNG reader to prove what was drawn: dimensions from IHDR, and
// the top-left pixel (row filter 0, so the first bytes after it are raw RGB).
function readPng(buf) {
  assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = require('zlib').inflateSync(Buffer.concat(idat));
  assert.equal(raw[0], 0, 'first row uses filter 0');
  const hex = (i) => '#' + [raw[i], raw[i + 1], raw[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { width, height, corner: hex(1) };
}

test('apple-touch-icon.png is a real 180px PNG in the theme ground color', async () => {
  setEnv('THEME', null);
  const r = await fetch(base + '/apple-touch-icon.png');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\/png/);
  const png = readPng(Buffer.from(await r.arrayBuffer()));
  assert.equal(png.width, 180);
  assert.equal(png.height, 180);
  assert.equal(png.corner, '#17402C'); // the corner is always bare ground
});

test('THEME=ahg paints the iOS icon blue — the whole point of rasterizing it', async () => {
  setEnv('THEME', 'ahg');
  const png = readPng(Buffer.from(await (await fetch(base + '/apple-touch-icon.png')).arrayBuffer()));
  assert.equal(png.corner, '#0061AB');
  assert.equal(png.width, 180);
});

test('the manifest PNGs are themed too, at their declared sizes', async () => {
  setEnv('THEME', 'ahg');
  for (const [p, size] of [['/icon-192.png', 192], ['/icon-512.png', 512]]) {
    const r = await fetch(base + p);
    assert.match(r.headers.get('content-type'), /^image\/png/);
    // the static file of the same name would not carry this header — proof
    // the dynamic route is the one answering
    assert.match(r.headers.get('cache-control') || '', /no-cache/);
    const png = readPng(Buffer.from(await r.arrayBuffer()));
    assert.equal(png.width, size);
    assert.equal(png.corner, '#0061AB');
  }
});

test('the drawn mark actually covers the ground (it is not a blank square)', () => {
  const px = require('../server/lib/iconPng').rasterize(64, '#000000', '#FFFFFF');
  let lit = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] > 128) lit++;
  assert.ok(lit > 200, `expected the box and check to be drawn, got ${lit} lit pixels`);
  assert.ok(lit < 64 * 64 * 0.6, 'the mark should not flood the whole icon');
});

test('theme-color follows the palette, so the phone browser chrome matches', async () => {
  setEnv('THEME', 'ahg');
  for (const p of ['/', '/index.html', '/admin.html']) {
    const html = await (await fetch(base + p)).text();
    assert.match(html, /<meta name="theme-color" content="#0061AB">/, `${p} is repainted`);
    assert.doesNotMatch(html, /content="#17402C"/, `${p} keeps no default green`);
  }
  setEnv('THEME', null);
  const back = await (await fetch(base + '/')).text();
  assert.match(back, /<meta name="theme-color" content="#17402C">/);
});

test('the served page is otherwise byte-identical to the file on disk', async () => {
  setEnv('THEME', null);
  const served = await (await fetch(base + '/index.html')).text();
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.equal(served, onDisk, 'only the theme-color value may differ, and it does not at the default');
});
